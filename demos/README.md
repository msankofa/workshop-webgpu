# demos/

Standalone pages for evaluating a technique before deciding whether it belongs in the game. Nothing
here is imported by `environment-viewer.html`, the bot viewers, or any module in the repo — the
dependency only ever points inward, never out.

Most demos are one HTML page each with their own `<script type="module">`, their own importmap, and no
dependency on the rest of the workspace at all. **Three demos import upward**, and for the same reason:
the whole point of each is to argue for shipping a module, and a demo carrying its own private copy
would be arguing for nothing.

- `spsa-gait-tuning.html` imports `../spsa.js`, a pure leaf with no imports of its own.
- `sdf-bug-v2.html` imports `../creature-locomotion.js` by way of its own `bug-rig.js` — the creature
  sim's walk cycle, extracted so this page and `port-creature-system.js` run the same gait instead of
  two hand-synced copies of it. This is the inward-pointing rule at its strictest: the demo needed the
  code, so the code moved rather than being copied.
- `flight-sim.html` imports `../flight-model.js`, `../flight-airframes.js`, `../flight-terrain.js`,
  `../flight-ai.js` and `../flight-combat.js` — the flight harness, extracted out of this page once
  it had proved itself and now covered by `test-flight-*.mjs` at the repo root. See
  `docs/subsystems/flight.md`.

**Two CPU twins live here as separate modules**, `creature-collision.js` and `bug-sdf.js`. Each mirrors
a distance field that otherwise exists only inside a fragment shader, split out for exactly the reason
`forest-cull.js` is: so the maths can be tested in Node without a GPU. They are not used the same way,
though — `sdf-creature.html` imports `./creature-collision.js` and needs it at runtime to resolve the
cursor blob, whereas `sdf-bug.html` imports nothing at all and `bug-sdf.js` is read only by
`test-demo-sdf-bug.mjs`.

The isolation that rule protects — a demo cannot break the game — still holds either way: nothing in
the game imports a demo, and the modules are leaves plus three.

Serve them over http (the importmap and CDN fetches do not work over `file://`):

```
python serve.py
```

then open `http://127.0.0.1:8080/demos/<file>.html`.

---

## Attribution

`sdf-creature.html`, `sdf-bug.html` and `volumetric-smoke.html` exist because of a three.js demo posted by
**Drin ([@DrinLajci](https://x.com/DrinLajci))** on **2026-08-06**:

> This alien has no geometry.
>
> No model, no textures, no vertices.
> The scene is one fullscreen quad and every pixel is solved in the fragment shader by raymarching a
> signed distance field.

The technique, the framing, the one-eyed horned alien and the cursor-driven blob are Drin's work. In
the original the purple lobe is attached to the mouse and fuses into the body as it is dragged over —
that interaction is the demo's real point, not a detail of the pose. `sdf-creature.html` is a
reimplementation in Three.js r0.184's WebGPU/TSL node system (the original is a GLSL fragment
shader); `volumetric-smoke.html` takes the same core idea — solve the picture per pixel by marching a
ray — and applies it to a density volume, which is the form that fits this project. `sdf-bug.html`
aims the same technique at one specific photograph, to find out how much of a finished image it can
carry and where it stops.

---

## `sdf-creature.html` — a creature with no geometry

A one-eyed alien built entirely from signed distance functions: three primitives (sphere, ellipsoid,
round cone), a smooth union, a smooth subtraction, and a material id carried alongside every
distance. The scene graph contains two triangles.

**Two views.**

- **Stage** — the creature filling the window, draggable, with anatomy sliders. This is the direct
  reimplementation of Drin's demo.
- **Start screen** — a mock character-select screen with four portrait cards. Each card is a quad
  placed over the card's own `getBoundingClientRect()`, running the same shader with different
  uniforms. This is the part that argues for the technique.

**Why it is in this repo.** Not as a renderer. Marching every pixel of the screen competes with the
rasterizer and cannot coexist with CDLOD terrain, the GPU forest, water and 90 instanced bots.

It is here because the project has no portraits, no avatars, no thumbnails and no loading visual
anywhere. `start-screen.js:579-599` is a flat `#12161d` panel with a text status line, and the role
and map picker cards are solid `#1a2029`. A shader-drawn creature fills those with no asset to
author, no GLB to load, no render target to manage, and no geometry in the scene graph — and its
cost is fixed by the size of the box it is drawn in. Switch views and watch the marched-pixel
readout: four 208px cards cost a small fraction of one fullscreen pass.

The variant uniforms are the second argument. Body width, horn length, eye size, leg length and the
whole palette are numbers, so a roster of visually distinct creatures is one shader plus a seed.

**The cursor blob is the main event.** Move the pointer (no button) and the purple lobe follows it,
fusing into the body with a real filleted surface wherever the two overlap. Hold a button to turn the
creature instead. This is the interaction from Drin's original, and it is the clearest statement of
what the technique buys: the blob is a second ellipsoid smooth-unioned into the body inside `map()`,
re-solved from scratch for every pixel of every frame, so dragging it halfway through the torso costs
one extra distance evaluation and nothing else. No re-meshing, no CSG pass, no buffer upload.

Compare that to the mesh path in this repo. `model-csg.js` does BSP booleans, and its own header
notes that output is non-indexed, triangle count grows with each cut and coplanar faces fragment —
so this is bake-time work, not something to do per frame. It also has **no fillet operation at all**,
so the soft fused seam here is not merely cheaper on the SDF side; it is a shape the mesh path cannot
currently produce at any price.

Two sliders make the point concrete. **Blend radius (k)** is the smooth-union parameter: at 0.01 the
blob is a ball resting against the skin, at 0.5 it starts reaching for the body from a hand's width
away. **Depth from body** pushes it through the torso and out the other side.

Placing the blob is the only part that needs JS — the cursor is unprojected through the same virtual
camera the shader builds, and the shader is handed one world-space point. Everything after that is
the smooth union. That unprojection was checked numerically over 720 camera and cursor combinations
by recovering the cursor position back out of the world point through dot products; worst error was
2e-15, and the near-pole case stays finite.

### The blob is a light

The blob emits. It glows on its own surface, casts a coloured pool onto the body through a real
shadow ray, and leaves a halo in the air around its silhouette. All three are the same distance field
answering different questions, which is why the light lands on the *deformed* surface rather than on
where the surface used to be — nothing has to be told about the dent.

The glow bleeds across the fused seam because the emission is driven by the blended material id, the
same value that already carries the colour across. The shape and the lighting agree without being
made to.

One implementation note worth knowing if you copy this: the shadow ray toward the blob is bounded to
stop just short of the blob's own surface (`softShadow`'s `maxT`). The blob is part of the same field
it is lighting, so without that bound it occludes itself completely and casts nothing at all.

### Phase versus collide

**Phase** is Drin's original, and it is *two* behaviours at once — easy to miss until you take one
away. The centre goes wherever the cursor is (they interpenetrate), **and** the smooth union fuses
them into a single continuous surface with a fillet and a colour that bleeds across the seam. The
fusing is the headline of the technique.

**Collide** is the deliberate counterpoint, and it has to undo both halves or it undoes neither. The
blob is stopped at the surface, *and* the blend radius drops to a hairline so the two keep their own
silhouettes, their own colours, and meet at a crease instead of melting together. Stopping the blob
without also killing the blend still produces one fused object; it just produces it slightly further
out. The two modes therefore drive the same uniform from different sliders — **Fuse radius (phase)**
and **Contact fillet (collide)** — because they want opposite things from it.

What replaces the fillet as the contact cue: the body dents inward under the blob, the blob flattens
against it, ambient occlusion darkens the crevice between them, and the blob casts a key shadow onto
the body it is resting on.

The deformation shares are complementary by construction — **Body give** decides how much of the
requested press the body absorbs, and the blob is stopped short by whatever is left, so it comes to
rest exactly as deep as the dented surface has receded. At `Body give` 0 the body is rigid and the
blob sits tangent to it; at 1 the body swallows it up to the dent cap. **Blob give** is the separate
cosmetic flattening.

### The material-id ordering is load-bearing

`sminM` blends the material id along with the distance, which is what carries colour across a fused
seam. The trap is that a linearly blended id **walks through every palette entry it passes**: with
ids skin 0 and blob 3, the seam is briefly id 1 and id 2, so it paints two bands of unrelated colour
across the join — measurably, the fused seam ran skin → eye-white → horn-orange → blob.

The fix is two rules, both worth stealing if you build a palette this way:

1. `ID_BLOB` is **1**, immediately next to `ID_SKIN`. Theirs is the only union whose id is blended,
   and adjacency is what stops the walk crossing anything.
2. Every other union switches its id at the midpoint instead of ramping (`sminHard`, and the hard
   pick in `opSubM`). The *shape* is still smoothly fused; only the colour changes on a line. Horns
   and the mouth interior are nowhere near skin in the palette, so they must not ramp.

The palette weight band is exactly one slot wide, which is the largest width that still guarantees a
non-neighbour contributes nothing and the smallest that lets a blended id ramp across the whole
fillet rather than snapping halfway. Swept over the full id range: no contamination anywhere, and
every integer id resolves to exactly one palette entry.

The dent cap is not a taste call. The dent is a value *added* to the shader's distance field, so its
gradient adds to the field's own; past roughly 0.6 blob radii the sum exceeds 1, the march starts
overshooting, and holes open in the silhouette. `test-demo-creature-sdf.mjs` asserts it as a bound.

**Where the collision is solved, and why it is not in the shader.** Resolving contact needs the
body's distance *at the blob centre*, which the fragment shader cannot ask for — the answer is needed
inside the same `map` function that would have to supply it, and shaders do not recurse. So it is
solved once per frame on the CPU in `demos/creature-collision.js`, a hand-synced JS twin of the body,
and handed to the shader as four plain uniforms. That is the same pattern (and the same drift caveat)
as `forest-cull.js`, `light-cluster.js` and `post-grade.js` one directory up. The twin is
deliberately coarser than the shader — legs, body, horns and eye, no mouth cut and no tooth — because
a collision proxy is allowed to be simpler than the render surface and every feature left out is one
less thing that can drift.

**The approach that did not work.** The obvious method is to push the blob's centre out along the
body's gradient. It fails: deep inside a field built from smooth unions the gradient stops pointing
at the nearest surface, and a centre dropped in the middle of the torso gets ejected *downward*
through the legs. The shipped version sphere-traces the blob's centre along the cursor ray instead,
which never evaluates the field deep inside and so cannot be misled — and is the truer model anyway,
since the cursor is holding the blob on a stick and the blob should stop where it touches.

`node test-demo-creature-sdf.mjs` covers the twin: 87 checks over the primitives, the field's
gradient bound, and contact resolution. The tunnelling regression is the one to watch — it sweeps 600
cursor rays across the creature and asserts the blob centre never ends up inside the body. The
gradient-push version failed exactly that check.

**Other things worth looking at.**

- The eye. Iris, pupil, glint and the blink are all angular bands painted on the eyeball's surface —
  no extra shapes, no extra distance evaluations.
- The soft shadow. It falls out of the distance field for free (clearance over distance travelled),
  with no shadow map. Toggle it off to see what it is buying.
- The rounded card corners are a 2D distance field, three lines long, masking alpha.

**Controls of note.** "Resolution scale" and "soft shadows and ambient occlusion" are the two cost
dials — the second one now gates two shadow marches per pixel rather than one, since the blob light
casts its own. `MARCH_STEPS` (88), `SHADOW_STEPS` (20) and `AO_SAMPLES` (4) are constants at the top
of the script.

**Files.** `sdf-creature.html` plus `creature-collision.js` (the CPU twin) and
`test-demo-creature-sdf.mjs` at the repo root. The twin is the only part of these demos that is not
self-contained in one page, and it is split out for exactly the reason `forest-cull.js` is: so it can
be tested in Node without a GPU.

---

## `sdf-bug.html` — one specific photograph, with no photograph

`sdf-creature.html` settles that a shape can be an expression. This page asks the next question: aimed
at a **particular image** rather than at a shape, how much of it does the technique actually deliver?

The target was a macro shot of a small round beetle sitting on a brussels sprout — the bug back-lit so
its shell glows green-to-orange, two huge glossy black eyes, six thin translucent legs, dew sparkling
on the leaf, and the whole background dissolved into green bokeh.

### What the distance field gave for free

All of these are the same field answering different questions, which is the property being tested:

- **The contact shadow under the bug.** The shadow ray from a point on the leaf toward the key light
  hits the body, because the bug and the leaf are one function. Nothing was told the bug is standing on
  anything, and there is no shadow map, no light camera and no second render of the scene.
- **The occlusion where six legs meet the leaf**, from the same field again.
- **The glow through the shell**, which is the single term that makes the bug read as alive rather than
  moulded. Thickness is four samples stepping into the surface toward the light, asking whether we are
  still inside. Thin places — leg segments, the shell's rim, the edge of the pronotum — light up; the
  middle of the abdomen stays opaque. The rasterised equivalent is a thickness map baked per model in
  UV space, which is wrong the moment a shape parameter changes. Here the body-width slider thickens
  the glow correctly, because there is nothing to re-bake.
- **The eyes.** Iris, pupil, two glints and the green edge caught off the leaf are angular bands on the
  eyeball's own surface: four spheres' worth of apparent detail for zero extra distance evaluations.
- **The wing-case lip.** A dark band where the surface turns vertical, which on an ellipsoid is exactly
  where the elytra overhang. The geometry picks the line out; nothing is authored for it.

### What it did not give, and this is the honest half

The photographic look is a separate job from the shape, and most of what makes that reference read as
a photograph is not the subject at all:

- **The bokeh background is not geometry and is not marched.** A real out-of-focus background contains
  nothing to solve — it is large soft shapes and blown highlights — so it is nine authored discs in
  screen space, with values well above 1 so they clip through the tone curve.
- **The depth of field is a second pass over a render target**, exactly as it would be for a rasterised
  scene. Pass one writes linear HDR colour plus normalised depth into a half-float target; pass two
  gathers a jittered golden-angle disc and keeps each tap only in so far as its own circle of confusion
  reaches the centre pixel, which is what stops the blurred background bleeding over the sharp subject.

So: the distance field drew the subject and lit it. It did not make the picture look photographed.

### The leaf is a quadratic, and that was not a premature optimisation

This began by sphere-tracing `min(bug, leaf)` from the camera, the way `sdf-creature.html` does. At
this framing it does not work, and the numbers are in the test:

| | whole-scene march | shipped trace |
|---|---|---|
| distance evaluations per pixel | 12.7 | **2.4** |
| pixels that exhausted the loop bound mid-scene | 0.2% | **0** |

The leaf is a 2.4-unit sphere seen from 2.55 units away, so a wide band of pixels crosses it at a
glancing angle — and a ray tangent to a sphere of radius R passing at clearance e needs roughly
`1.8 * sqrt(R/e)` steps to get by. The average cost was survivable. The **stalls were not**: a ray that
gives up mid-scene draws backdrop through a surface, and they cluster along the leaf's silhouette,
which is the edge the eye is most likely to be resting on.

So the leaf is not marched. It is a sphere, so its intersection is a quadratic — exact at every
incidence angle including tangency, constant time, and free for the two thirds of the frame that miss
both bounding volumes. Only the bug is sphere-traced, and only inside its own bounding sphere.

Three consequences worth carrying away:

1. **The leaf's surface variation can no longer be a displacement of the field**, because a displaced
   sphere is not a quadratic. It is a normal perturbation in the shader instead. That happens to agree
   with the subject: the reference sprout has a clean silhouette with all its texture in the shading.
2. **Foot placement became a closed form.** Each foot's height is solved from the leaf rather than
   authored, so the bug stands on the surface at any leg spread and any leaf radius — drag the leaf
   radius slider and the legs re-solve their footing every frame. That is only cheap because the leaf
   is exactly a sphere.
3. **`sceneMap` is still the full field**, and still what the normal, shadow, occlusion and thickness
   taps read, because those ask for the distance from an arbitrary point and only an SDF answers that.
   The acceleration is for the primary ray alone.

### The back-lighting default is load-bearing

The transmission term is a back-lit approximation driven by `dot(rd, lightDir)`, which is only positive
when the light is on the far side of what you are looking at. Put the key on the camera's side — the
obvious instinct — and the shell's glow silently does not fire at all. So the key defaults *behind* the
subject, and its azimuth is relative to the camera, because the camera orbits and a world-fixed key
would swing round to the front and take the glow with it. The camera-facing side is carried by the sky
fill, the leaf bounce and the rim. `keyFollow` at 0 pins the light to the world, which is the setting
for judging whether the shape is right rather than whether the picture is pretty.

### The grade is ours on purpose

`renderer.outputColorSpace` is linear and tone mapping is `NoToneMapping`, so the renderer does not
insert its own output pass; tone map, gamma and vignette all happen at the end of the blur pass. With
the defaults left alone the renderer applies sRGB on top and the image washes out.

Noted while establishing that: **`sdf-creature.html` has that double application.** It gammas manually
and leaves `outputColorSpace` at its r0.184 default, so the curve is applied twice. Left alone, because
fixing it changes how that page looks and that is a taste call rather than a correctness one.

### Verification, given that none of it can be checked in Node

`demos/bug-sdf.js` is a hand-synced CPU twin of the field and `node test-demo-sdf-bug.mjs` asserts
1075 checks over it. Unlike `creature-collision.js` this twin is deliberately **not** coarse — that one
is a collision proxy and is allowed to be simpler than the render surface; this one is a test oracle,
so every part of the field with a distance is in it. What is absent is only what has no distance: the
palette, the painted eye, the dew, the subsurface term, the backdrop, the blur.

The checks that earn their keep are the ones covering failures a screenshot hides:

- **All six feet reach the leaf** at every leg spread and every phase of the idle cycle. A bug hovering
  a centimetre off the leaf reads as "the contact shadow looks a bit soft", not as a mistake. This is
  also why the idle bob is applied to the hips and head and never to the feet, which the test asserts.
- **The whole bug stays inside the bounding sphere its march is confined to**, at the extremes of every
  slider. Outside it, a part of the model silently stops being drawn — an antenna slider at maximum
  would just lose its tips, with no error anywhere.
- **The field never gets steeper than the step factor can survive.** The shell's centre groove is a
  displacement *added* to the field, so its gradient stacks on the body's own; past a sum of 1 the
  march overshoots and pinholes the silhouette, and pinholes open in the busiest part of the image
  first, where they read as detail. Measured worst gradient 1.10, step factor 0.85, so 0.85 × 1.17 is
  the asserted bound with the margin deliberately thin.
- **The accelerated trace agrees with a slow march of the same field**, which catches both a bounding
  volume that has lost part of the model and a march that has tunnelled through one.
- **The default framing puts the subject in shot** at 38% of frame height, right of centre, uncropped,
  with the centre ray landing on the bug so the autofocus finds it. That is the one thing a screenshot
  answers instantly and Node normally cannot.

Two of those checks were wrong before the code was. Worth recording:

- Judging the analytic leaf against a slow march of the same sphere **failed**, four rays in 2880 — and
  the slow march was wrong every time. A ray skimming a large sphere keeps a small distance over a long
  stretch, so `d < eps * t` fires well before the true tangent point, and for a ray passing just
  outside it fires when the ray never touches at all. That is the same property that made the leaf
  expensive to march, seen from the other side. The leaf is now checked against the sphere itself,
  which holds at every angle and is a stronger statement than the march could have made.
- The depth sort looked barely exercised at the default view — 227 pixels of 88,000. Investigated
  rather than assumed: the leaf is tangent to y = 0 and the bug's body sits entirely above it, so a ray
  aimed at the shell descends too shallowly to reach y = 0 before passing beyond the leaf's edge, and
  never enters the sphere. Only the contact zone around the feet has two surfaces to sort. That is the
  reference photo's framing — subject against bokeh, not against leaf — so the sort is now exercised at
  a second, lower camera where the leaf genuinely occludes.

### Controls of note

"Resolution scale" and "shadows, occlusion and subsurface" are the cost dials; the second gates a
shadow march, four occlusion taps and four thickness taps per pixel. "Blur" in the debug row shows the
circle of confusion directly, which is the fastest way to see why something is soft. The wing-case
groove slider goes past its default on purpose — turn it up and watch the silhouette begin to pit,
which is the overshoot the test bounds at the default value rather than at the slider maximum.
`MARCH_STEPS` (96), `SHADOW_STEPS` (16), `AO_SAMPLES` (4), `SSS_SAMPLES` (4) and `DOF_TAPS` (64) are
constants at the top of the script.

### Files

`sdf-bug.html` plus `bug-sdf.js` (the CPU twin) and `test-demo-sdf-bug.mjs` at the repo root. Same
split, and for the same reason, as `sdf-creature.html` and `creature-collision.js`. `sdf-bug-v2.html`
below is this page with a gait; v1 is left alone.

---

## `sdf-bug-v2.html` — the same bug, walking

v2 is v1 with a gait. The bug wanders the leaf on an alternating tripod, and the walk cycle is not
written here: it is `../creature-locomotion.js`, the same module `port-creature-system.js` runs. This
page is the reason that module exists as a module.

**The mirror had to go, and that is the interesting part.** Every paired thing in v1 is one expression
evaluated at `abs(p.x)` — three leg expressions standing in for six legs. A gait is left/right
asymmetric by definition; an alternating tripod means the left and right of each row are in *opposite*
phase. So the legs are now six independent evaluations reading their joints from uniforms, and the leg
term of the field costs exactly twice what it did. That is not recoverable, and it is the price of the
feature rather than an oversight. The eyes and antennae are still mirrored, being still symmetric.

**v1's feet were pinned on purpose, so animating them inverts a decision.** v1's idle bob is applied to
the body, hips and head rather than to a warp of `p`, specifically so the feet do not move — there is a
comment in v1 saying so. In v2 the rig owns the hips and the feet, and the bob is back to being what it
claimed to be: breathing.

**The body moves by moving the sample point, not the primitives.** `bugMap` carries the incoming world
point into authored space first (`pA = BODY_PIVOT + Rᵀ · (p − bodyPos)`) and hands that to the body code
unchanged, so every primitive stays written where it was drawn and the whole body walks for free. This
is legal because a rotation is an isometry: the distance is the same measured in either frame, which is
also what makes it safe to union a body distance computed in authored space with a leg distance computed
in world space. A non-uniform scale would *not* be safe, which is why `bodyWidth` still lives inside the
ellipsoid radii rather than being applied to the point.

At rest `bodyPos === BODY_PIVOT` and the rotation is exactly the identity, so authored space *is* world
space and v2's parked frame is v1's image. That is an assertion, not a hope — see below.

**And the same transform has to be applied to the SHADING, which is where it was missed.** Moving the body
splits the shader into two spaces, and every quantity that was authored in body space has to be evaluated
in body space — not only the distance field. The shell's green-to-orange ramp was carried over correctly.
The eye's painted face was not, and the picture is where it showed: the iris, the pupil and both glints
are angular bands measured from the eye's centre, so evaluated with a world-space point against an
authored centre the vector is dominated by the bug's offset from the origin. Measured over 121 samples of
the eyeball's surface, `dot(en, glintA)` collapsed from its full −0.98…0.98 to a 0.08-wide range sitting
at −0.8: not one band fired anywhere on either eye, at any pixel. What survived was the base colour and
the view-dependent green bounce, so the eyes rendered as flat grey-green discs — plausible enough to read
as a *material* mistake rather than a coordinate one, which is why it lasted. `sign(p.x)` was picking the
side in world space too, giving both eyes the same one. The fix is to use `pA` and to rotate the view
direction to match; the dot products are unchanged by that, a rotation preserving them.

Two lessons worth keeping. The first is that a "flat, washed-out" look is a plausible symptom of a
coordinate bug, not just of bad colour choices — the giveaway is a *constant* where there should be
variation. The second is that `_check_sdf-bug-v2.html.mjs` already asserted the shell ramp read `pA`, and
that check was written by transcribing the fix I had just made rather than by asking what *else* was
authored in that space. A rule that covers one instance of a class is worth turning into a rule about the
class: the eye's bands are now checked too, and the check was verified by putting the bug back.

**Still in world space, and it should not be: the elytra lip band.** `lipBand = exp(−(n.y/0.14)²)` darkens
the shell where its surface turns vertical, which on an ellipsoid is exactly where the wing case overhangs
— a property of the bug, so it belongs in authored space. Against the world normal it slides as the bug
tilts, and the tilt is not small: median 11.8° over four seeded walks, 22.6° worst. The band is 16.1° wide,
so a point that should be fully dark keeps 12% of the darkening at the median tilt and none at all at the
worst. It is a one-line change (`n` rotated by the inverse rows) but a visible one, so it is left alone
here rather than folded into an eye fix.

### The tripod is not new code

`BUG_GAIT` sets `rowPairSteps: false` (the walk scheduler) and `maxConcurrentFraction: 0.5`, and the
insect tripod falls out of the existing scheduler unchanged. It spreads steps across `leg.phase`, which
the sim computes as `(row + (side > 0 ? 1 : 0)) % 2`; for three rows that is

    phase 0 = front-left, middle-right, back-left
    phase 1 = front-right, middle-left, back-right

which is exactly the tripod. `0.5` of six legs lets one whole tripod leave the ground at once, and the
scheduler's "don't step two legs of the same phase" rule is gated on `legs.length <= 4`, so at six legs
it correctly does not apply. Measured over 30 s of walking, three-airborne is the dominant state and
four never happens.

### Scale was the work, not the porting

The stock gait is metres for a creature whose femur is 0.58; this bug's is 0.206, its whole foot radius
is 0.010 against a default foot clearance of 0.06, and `GAITS.walk`'s `stepLift` of 0.24 is larger than
the bug's entire femur. Geometry scales freely and the timing does not come along, so `BUG_GAIT` is
authored against the bug's own leg length rather than scaled from `GAITS.walk`. `stepDuration` at 0.115
is the single biggest departure — insects step fast. Those numbers were tuned by eye and are not derived
from anything; the three presets (Creep, Scurry, Dash) are the same code with different ones.

### The knee was bending backwards, and no amount of iteration would have found it

The legs looked wrong in motion, and the measurement was worse than the impression. Over a 60 s walk the
knee sat **below the hip-to-foot chord 63% of the time** — 84% on the front legs — with the femur pointing
*down* at a median −28° where the drawn pose has it up at +24°, and the hip swinging through a full 180° of
azimuth. Standing still it was 0%, and on flat ground still 56%, so it was the solver in motion rather than
the dome.

The cause is structural. Two segments plus a target admit a whole **circle** of valid knee positions, and
FABRIK picks one by resuming from wherever the chain already is. Every one of those poses satisfies the
constraints it is solving, so it was not converging on a wrong answer — it was converging on an answer
nobody had specified. The fix is `solveTwoBone` in `creature-locomotion.js`: an analytic solve told which
side to bend toward. **The pole is measured, not chosen** — it is the authored knee's own offset from the
authored chord, so the solve reproduces v1's drawn pose exactly at rest and keeps that same side
everywhere else. Inversion is now 0% at every leaf radius, bone lengths are exact rather than iterated,
and it is one shot instead of up to twelve passes.

Two limits sit on top, and **where each is enforced mattered more than its value**:

- `swing` (±45°) bounds where a foothold may be *placed*, at 70% of the limit so a freshly planted foot is
  not already at the wall, and asks for a step once a planted foot drifts past the full limit.
- `reach` (0.99 of full extension) bounds the *solve* only. An unreachable target leaves the leg bent
  instead of snapping into a straight line. The cost curve has a corner there: at 0.99 the drawn foot is a
  median 0 mm and p95 14 mm from its target with no near-straight leg ever, 0.999 buys 4 mm back and
  returns the straight-leg snap on 7–8% of samples, and 0.94 triples the error to 43 mm.

**Four things were tried and removed, each because it measured worse than nothing.** They are recorded
because the shapes are all plausible and three of them made the demo visibly worse:

1. *Reach as a placement bound.* Pulling footholds in toward the hip crowds the feet under the body, which
   shrinks the support polygon; on a 1.4 m leaf the body's centre then left it and three of five wander
   seeds slid off past the equator. Reach belongs in the solve.
2. *Reach as a step trigger.* Once reach no longer bounded placement, nothing kept a planted foot near the
   limit, so the trigger fired continuously on legs that could do nothing about it — `wants` was set on
   most legs, the scheduler's adjacency rules then vetoed every candidate, and all five seeds left the leaf.
   A limit may drive a trigger only if something also keeps the value near it.
3. *A turn brake.* Turning under planted feet is what actually produces the wide hip swing — the arithmetic
   agrees, a 155 mm stride on a foot 260 mm from its hip is only ~17°, while `turnSpeed` 2.6 rad/s spins the
   body 60° under a foot planted for 0.4 s. Slowing the turn in proportion to the swing left moved p95 swing
   from 49.3° to 45.9° across its whole useful range, and one setting left the bug unable to turn back from a
   small leaf's rim at all.
4. *Setting `uncomfortable` from the swing limit.* That flag also freezes steering and cuts speed, so the
   bug stopped turning entirely and walked straight off the leaf.

**So hip swing is still not bounded**: p95 ~48°, peaks near 70°, essentially unchanged. The knee inversion
and the straight-leg snap are fixed; the swing needs a gait-level answer — how much yaw may happen per
stance period — and that is open.

One shared-code bug fell out of this. `canWalkLegMove` vetoed a step if the foot was within a hardcoded
0.1 m of its target. That is a length, so it has to scale with the creature: 0.1 m is a sixth of this bug's
whole leg span and wider than most of its strides, which silently forbade the step and stranded the leg. It
is `gait.restepEpsilon ?? 0.1` now, so the sim's behaviour is unchanged and the bug sets 0.012.

The panel's **Joint limits** checkbox switches the solver as well as the bounds — it had to, because
relaxing the bounds alone leaves inversion at zero. The pole is what fixes the knee, so a comparison that
kept the pole would have been a comparison of two correct poses. The readout under it counts inversions
since the walk began: 0.0% on, 59.5% off.

### Six bugs, each its own size, on a dome or a flat disc

Three changes that turned out to share one piece of plumbing.

**Every per-bug field lives in one packed `uniformArray`, and the reason is a device limit rather than a
budget.** The field has to be evaluated for a *specific* bug from inside a loop, so the index is a value
rather than something known when the shader is written; that needs a dynamic `.element(i)`, which works, as
does index arithmetic.

The first version gave each field its own array — eighteen scalars, seven colours, five vectors and the
joints, thirty-two in all. Every `uniformArray` is a `BufferNode`, which means **its own binding**, and WebGPU
guarantees only `maxUniformBuffersPerShaderStage = 12`. The page went black with:

```
THREE.[Invalid PipelineLayout (unlabeled)] is invalid due to a previous error.
 - While calling [Device].CreateRenderPipeline(...)
```

which names the pipeline and not the cause. Nothing in Node could have caught it: the graph builds, every
array is valid, and only a real device consults the limit. It is one packed `vec4` array now — a stride of 16
per bug, with a table saying which slot and component each field lives in so the CPU writer and the shader
reader cannot drift — plus one for the joints. Two bindings.

The padding is what makes the packing free rather than a compromise: every element pads to a `vec4` anyway, so
three floats riding along beside a `vec3` cost nothing. That padding was noticed *before* the failure and
dismissed as "not worth packing at six bugs", which was true about bytes and irrelevant to the thing that
actually broke.

**One march per bug, not one march over all of them.** Taking `min` across every bug at each step would make
every step N times dearer for every marching pixel. A separate span-bounded march per bug means a pixel only
pays for the bugs its own ray crosses — for bugs a body-length apart, one. Each march is also cut short at
the nearest hit found so far, so a bug behind another is not marched past the surface hiding it; the nearest
hit still wins whatever the slot order is, because a later bug that is genuinely nearer lies inside its own
truncated span.

**The per-bug loops are dynamic, over the live count rather than the slots**, and that is what sets the cap.
They were unrolled in JS first, which emitted a march per *slot* whether or not it held a bug and put one gate
compare per slot inside `sceneMap` — the function every shadow, occlusion and thickness tap calls. So the slot
count was a real cost and it was set to a cautious six. `Loop(u.bugCount, ...)` emits a real dynamic loop, so
the shader's size no longer depends on the cap and an empty slot is not visited at all.

**What actually bounds the cap, measured rather than guessed:**

| | |
|---|---|
| CPU walk | **6 µs per bug per frame** — 48 bugs is 1.7% of a 60 fps frame |
| Packed uniforms | **544 bytes per bug**, so WebGPU's guaranteed 64 KB binding holds about 120 |
| Shader | independent of the cap now that the loops are dynamic |

None of those is 6. The cap is 24, which is 12.8 KB — a fifth of the floor, with room for everything else in
the same binding. The live cost is linear in the bugs actually on the leaf, and each of those is bounded twice
over: its march only runs for pixels whose ray crosses its bounding sphere, and the shading taps reject it
with one subtract when it cannot beat the distance already found.

**The shading taps needed a reject, not just a `min`.** `sceneMap` is what the sixteen shadow steps, four
occlusion taps and four thickness taps call, so a naive loop over six bugs would multiply the most-called
function on the page by six. `length(p - centre) - radius` is a *lower bound* on the distance to that bug, so
a bug that cannot beat the best distance so far is skipped exactly rather than approximately. Shading taps
are local, so most bugs fall out on one subtract.

**Size is a rebuild, and the gait does not scale linearly.** A smaller bug has shorter segments, a lower
pivot and a shallower foot sink — but if its step timing came along multiplied by the same number, every size
would take the same number of strides per metre and they would all move like the original. Froude similarity
is what actually holds: lengths as `s`, times and speeds as `√s`, angular rates as `1/√s`. So a half-size bug
steps 1/√2 as far in 1/√2 the time and turns √2 as fast, which is why small insects look frantic. Getting the
*dimensionless* list right is most of the work — body height is a fraction of the leg, look-ahead multiplies
an already-scaled distance, and the rotation lerps are blend factors rather than rates, so none of them move.

**The field now speaks one frame.** The body was in authored space and the legs were in world space, which
worked only while both were the same size; with a scale in play it would have meant multiplying some terms
and not others. The rig hands over unit-authored joints instead, so the whole field is evaluated at size 1
and the scale is a single multiply on the way out. A rotation followed by a uniform divide is a *similarity*,
so a distance measured there times the scale is the true distance — which is what keeps the march safe. As a
side effect it removes the mixed-frame hazard that made the eyes render as flat discs.

**The flat leaf is a solid, not a disc.** A zero-thickness disc would be unsigned, and the dome is a sphere
whose distance is signed and negative inside — the two shapes would then disagree about which side of the
surface a shading tap is on. So "flat" is the solid `{radial ≤ R, y ≤ 0}`, a half-infinite cylinder whose top
face is the leaf, and `length(max(q, 0)) + min(max(q.x, q.y), 0)` is its exact signed distance. It is bounded
by a radius rather than being an infinite plane, because a plane would fill everything below the horizon and
take the out-of-focus background with it — and the background is half of what this demo is arguing about.
Three other things follow the shape and would each be quietly wrong if missed: the leaf's normal, the
"brighter toward the crown" ramp (a height on a dome, which on a plane would flatten to one constant, so it
becomes a radial falloff), and the rig's own ground function.

**What this deliberately does not do: bugs do not collide.** Each steers by its own wander target and they
walk through one another. `demos/creature-collision.js` exists and would give separation cheaply, but that is
a behaviour change rather than a rendering one.

### What the leaf being a sphere buys, twice

The foot scan only ever samples the ground as a scalar — a 3×3 grid of calls, no raycasts and no meshes
— so `sqrt(R² − x² − z²) − R` is a drop-in for a heightfield. It is also *only* single-valued on the
upper hemisphere: past the equator it clamps to −R, which reads as a cliff and makes the scan correctly
report no reachable ground rather than guess. Keeping the bug inside `roamRadius` is what stops it trying
to walk down the underside of the leaf.

The bounding sphere the primary ray marches inside is now recomputed on the CPU each frame from the
joints that actually exist. v1 could hard-code it because the bug never moved; a constant would now
either clip a limb mid-step or have to be inflated to cover the whole roaming area, and the march's cost
is proportional to how much of the ray that sphere admits.

### Verification

`node test-demo-sdf-bug-v2.mjs` — 105 checks on `bug-rig.js`. The gait itself is not retested here; it is
covered by `test-creature-locomotion.mjs`. What this file checks is what v2 adds:

- The tripod: each phase is one leg per row with alternating sides, and `phase 0 === 0L,1R,2L`.
- **The parked pose reproduces v1 exactly**, cross-checked against v1's own CPU twin (`bug-sdf.js`'s
  `footPos`) rather than against arithmetic restated in the test. Worst disagreement: 0.
- Authored and world space are exact inverses *and* an isometry — the round trip and the distance drift
  are both about 1e-15, which is what licenses the mixed-frame union.
- 30 s of walking in each of the three gaits: travels, takes steps, never exceeds the concurrent-step
  cap, never lifts all six feet, never sinks through the leaf, FABRIK never stretches a bone, and every
  planted foot is *exactly* on the dome.
- The same at leaf radii 1.1, 2.4 and 5.0, and that changing the radius restands the feet.
- The bounding sphere contains every joint plus its capsule radius, over 21,600 joint-frames.
- The gait is frame-rate independent: 20 s of walking covers the same distance at 30, 60 and 120 fps.
- The joints stay plausible: no knee inverts over 60 s at any of three leaf radii, the drawn foot stays
  within 40 mm of its target at p95, the parked pose is untouched by the limits — and, asserted alongside
  every one of those, **the bug is still on the leaf**. That last one is not a nicety. Three of the four
  approaches that were tried and removed walked it off, and a falling bug reports plausible-looking joint
  angles right up to the moment it leaves, then swings 180° with a foot two metres from its target. Any
  joint measurement taken past the equator is a measurement of free fall.
- And that the old behaviour is genuinely one setting away: with `legSolver: 'fabrik'` and the bounds off,
  the same walk inverts on 59.5% of samples and snaps legs straight. A fix whose failure mode you cannot
  reproduce on demand is a fix you cannot demonstrate.

`node test-demo-sdf-bug-multi.mjs` — 97 checks on the multi-bug and flat-leaf machinery, and the file is
mostly a record of **what Node cannot check about a shader**. Measured against this build: `If` and `Loop`
callbacks run exactly *zero* times outside a shader build, and TSL does not throw, warn or error when a
function is called with a missing argument. So a deliberate `throw` planted inside the page's innermost march
loop left the first version of this file reporting 88 of 88, and an arity canary passed too. The fix is the
same one the eye appearances needed — put the work in something the test *calls* — plus moving the arity
burden onto the static checker, which counts arguments at every `bugMap(` call site with a balanced-paren
scan. What the file does verify for real: the uniform-array types and their padding, the field lookups and
the joint stride as a bijection, the per-step march expression, the flat leaf's signed distance against a
brute-force nearest point over 3,757 samples, Froude scaling term by term including the dimensionless ones
that must *not* move, and three differently-sized bugs stepped interleaved for 30 s without disturbing each
other's poses.

`node _check_sdf-bug-v2.html.mjs` — 110 static checks on the page: it parses, the leg block reads the
joint uniforms and never the mirrored point, the antennae and eyes still *do* read the mirrored point,
the shell gradient is sampled in authored space while the leaf's stays in world space, the bound comes
from uniforms, and no control in the panel is unwired.

That last category earned its place. The uniform check originally asked whether each uniform was
referenced anywhere on the page, and a slider reads and writes `u.x.value` — so when the legs moved to
uniforms and the shader stopped reading `u.legSpread`, the "Leg spread" slider went dead while the check
reported the page clean. It now requires every uniform to be read inside the *shader* region, which is
verified by injecting a uniform nothing reads and watching it fail. Leg spread is wired to the rig now:
a wider stance is a longer tibia, so it rebuilds the IK chains rather than nudging a number.

### Controls of note

"Resolution scale" runs to 4, and cost is quadratic in it: the march is per-pixel, so 2x is 4x the
distance-field evaluations. It is clamped to what the device can actually allocate
(`maxTextureDimension2D`, at least 8192 by the WebGPU spec) because past that a render target simply
fails and the slider would read as broken rather than limited; the stats line says when it clamps and at
what. On a 1080p display at DPR 2 the ceiling lands around 2.8, which is still about 11x the pixels of
the 0.85 default.

One coupling to know about, because it is visible rather than subtle: **"Maximum blur (px)" is in
render-target pixels**, so raising the resolution tightens the bokeh in the same proportion. Going from
0.85 to 2.8 makes the background blur about 3.3x smaller relative to the frame. That is a property
inherited from v1 and left as it was rather than quietly re-anchored; the blur slider's own maximum of 90
is not quite enough to compensate at the top of the range.

**Bugs.** "Save this bug" writes the draft's settings to `localStorage` under `pcw:sdfBugPresets`, and
"Spawn it" builds a new one from them. "Spawn a copy of this one" skips the save. The panel always edits slot
0, the draft, so once a bug is spawned it stops following the sliders - which is what makes several different
bodies possible at once. Six slots, and they do not collide.

**Leaf shape.** Dome or flat disc. Flat is worth reaching for when judging the gait rather than the picture:
curvature is the confounder in every measurement of this rig, and a plane removes it. It is also how the
knee-inversion bug was confirmed to be the solver and not the terrain - 56% on flat ground against 63% on the
dome, where a terrain cause would have collapsed toward zero.

**"hold the legs to a plausible pose"** under *Joint limits* is the before-and-after. Off, it puts the
unbounded FABRIK solve back and the knee inverts on about 60% of samples; the readout beneath counts that
live, since an inversion appears mid-stride and is gone before a half-second stats refresh would catch it.
The two sliders are the joint's own range — fore/aft swing in degrees, and how straight the knee may get as
a fraction of the leg's span.

"walk" parks the bug without resetting it; "Park at the authored pose" returns it to the frame that
matches v1. The three gait buttons rebuild the slider block so it shows the preset's numbers rather than
the previous gait's. "Feet off the ground at once" is the concurrent-step cap directly — drop it to 1 and
the tripod becomes a crawl; the stats line reports how many feet are planted, and how far the planted
ones are from the leaf's surface in millimetres, which should read 0.00.

### Twelve eyes on eight mounts

`bug-eyes.js` holds them. `EYE_STYLES` is the running order of the twelve **appearances**, with the array
index used directly as the uniform value so the dropdown, the branches and the tests cannot disagree about
which is which. All twelve are shading only and cost **no extra distance evaluations**: the field already
produced a surface normal, and a normal plus an authored frame is enough to paint a face onto a sphere.

`EYE_MODIFIERS` holds three independent **mounts** - stalked, ocelli cluster, cut-gem - as 0/1 flags. These
are the ones that change the field. **They were dropdown entries alongside the appearances at first, which
was a design mistake**: mount and appearance are different questions, and putting them on one axis forced a
choice between having a stalk and having any of the twelve looks on it. As separate axes there are 12 x 8 =
96 eyes instead of 15, and the extra 81 cost nothing to allow, because a mount reaches every appearance
through one shared function rather than through per-style code.

| # | Appearance | Technique |
|---|---|---|
| 1 | Glossy bead | The original. Two fixed angular bands plus the leaf's bounce. |
| 2 | Compound / ommatidia | Hex lattice in equal-angle coordinates; each facet is a flat lens pointing down its own cell's axis, so the key light splits into one highlight per facet. |
| 3 | Pseudopupil | `dot(en, -rd)` alone — the dark spot that follows the camera, as in real macro photographs. |
| 4 | Iris with parallax | Snell's law at the cornea, then intersect the bent ray with a plane behind the eye and paint rings where it lands. |
| 5 | Slit pupil | The same, with an anisotropic pupil radius: `length(vec2(q.x/w, q.y))`. |
| 6 | Toon | `posterize` to three bands, `step` highlight, `step` rim. Hard edges are the whole point. |
| 7 | Iridescent film | Hue from the view angle through `mx_hsvtorgb`. |
| 8 | Milky / blind | `mx_fractal_noise_float` cloud, heavy wrap, no specular. |
| 9 | Glowing sensor | Written HDR, so the depth-of-field gather blooms it into real bokeh for nothing. |
| 10 | Mechanical aperture | Rings, blades folded out of the azimuth, aperture animated on `u.time`. |
| 11 | Matcap | Frame built from the view direction, so the highlight never leaves the camera. |
| 12 | Wet meniscus | A hairline arc, width from `fwidth` with an object-space floor. |

And the three mounts, each combinable with any of the above and with each other:

| Mount | Technique | Cost |
|---|---|---|
| Stalked | The eyeball rides a tapered shaft out from the face. | Two extra segment evaluations. |
| Ocelli cluster | The domain is folded into one wedge, so N simple eyes are one primitive seen N times. | One sphere, whatever the count. |
| Cut-gem | The sphere intersected with five half-spaces. | Five `max` operations, no extra march steps. |

Composition order is fixed: the mount moves the centre, the cluster folds the domain about it, the cuts
apply to whichever eyeball that produced, and the shaft is unioned on last. Every combination is a legal
SDF - `min` is exact for a union and `max` never overshoots for an intersection, so sphere tracing stays
safe. **`eyeLocal` is the single seam**: both the field and the shading ask it where the eyeball is, so a
mount cannot move the geometry without also moving the highlights that sit on it. A cut gem additionally
swaps the analytic sphere normal for the field's own, or every appearance's highlights would sit on a ghost
sphere the silhouette contradicts.

**The maths is written once and runs in both places.** `bug-eye-math.js` holds the parts whose bugs are
invisible in a still frame — the eye's frame, the equal-angle projection, the hex lookup, the refraction
hit, the ocelli fold — in method-chaining style against four injected constructors. TSL nodes provide that
method surface natively and a ~50-line numeric shim in `test-demo-bug-eye-math.mjs` provides it over plain
numbers, so the same source is unit-tested arithmetically. This repo already carries three hand-synced
CPU/GPU twins and a fourth was not worth adding.

**Equal-angle, not equal-area, and that is a visual decision.** The facets are laid out in an azimuthal
equidistant projection of the eyeball, so they compress toward the rim the way a real eye's do. Laid out in
the tangent plane instead they would stay the same size on screen right up to the silhouette, which is the
tell of a texture rather than a surface.

**Verification, given that none of it can be seen in Node - and the three ways I got this wrong first.**

Reaching real coverage of shader code from Node took three corrections, and *each of them passed a canary
while executing nothing at all*:

1. **`Fn(body)()` does not run the body.** An early probe suggested it did - it returned a node - so the
   first version of the test asserted "all fifteen graphs build" while running none of them. A deliberate
   `throw` inside the body does not even escape.
2. **A throw inside an `If` callback does not escape either**, because the callback is *stored* and
   replayed during the shader build. So even with `setCurrentStack(stack())` making `If` and `toVar` work
   outside a builder, the appearance bodies were still unreachable - they were inline `If` bodies. The fix
   was structural: each appearance is now a **named function** that the branch merely calls, so a test can
   call it directly while the shader keeps its single cheap branch.
3. **TSL coerces types freely and reports arity as a console warning**, not an exception. A canary that
   passed a float where a `vec3` was expected was simply a *different valid program*. Warnings are now
   captured and failed on, and missing arguments are rejected explicitly - TSL will happily build a graph
   out of `undefined`, which is how a forgotten argument used to reach the GPU with every test green.

What the suite is now worth, verified by making one appearance call an unimported function - 88 of 96
pairings ran and the suite failed:

1. `test-demo-bug-eyes.mjs` **evaluates** all 96 appearance-and-mount pairings, plus the field for all
   eight mounts and the cluster at every count the slider offers.
2. `test-demo-bug-eye-math.mjs` runs the geometry on numbers: the basis is orthonormal on both sides, a
   known tilt round-trips through the projection, the hex grid tiles with no sample outside its own cell
   and equal interior populations, refraction pulls the hit inward and shifts monotonically with the view
   angle, and all N ring positions fold to one point.
3. `_check_sdf-bug-v2.html.mjs` checks the wiring, and reads the module as well as the page.

None of it says whether any of them look right. The standing lesson is the one that keeps recurring in this
directory: a test that passes tells you nothing until you have watched it fail.

**Four things went wrong, and the useful part is which layer found each.**

1. **`mx_worley_noise_vec3` does not return what I assumed.** The plan was Voronoi cells with the cell
   centre perturbing the normal; the function returns *sorted squared distances* (F1², F2², F3²) and no
   cell identity at all, from a 27-cell triple loop. Reading the shipped build rather than trusting the
   name is what changed the design — and a hex grid is both cheaper and more accurate, real ommatidia being
   hexagonally packed. Found before a line was written.
2. **The chained comparisons are REORDERED aliases.** `x.step(edge)` is `step(edge, x)`, and
   `t.mix(a, b)` puts the *interpolant* first. So the natural-looking `|d|.step(0.5)` selects every style
   **except** the one intended, and both style predicates were written that way round. No graph-building
   test can see it: the shader compiles and simply applies the wrong style. The predicate now lives in the
   maths module as `isStyle`, checked numerically against all fifteen indices — putting the inversion back
   fails eighteen checks.
3. **The ocelli overlapped at the top of their own slider.** The authored radius fits its wedge up to 8
   eyes and fails at 9, and the count slider goes to 10; past that the folded field reports less than the
   true distance. The radius is now derived from the count. The default-value test passed the whole time —
   sweeping the control's *range* is what found it.
4. **The facet default would have moiréd.** Cells across the eye is `pi * facets`, so the first default of
   14 meant 44 facets across roughly 90 screen pixels. Derived rather than eyeballed, and the slider now
   reads out the count across the eye, which is the thing being judged.

Two honest costs. The ocelli fold's `atan2` and the angular projection's `acos` are evaluated for every eye
pixel whatever the style, because the styles share one surface normal; that is a few operations in a
shading pass whose neighbour is a raymarch, not a bottleneck. And a style switch is genuinely free —
`u.eyeStyle` is uniform across the draw, so every lane takes the same branch, the same argument the file
already makes for `u.quality`.

### Files

`sdf-bug-v2.html` plus `bug-rig.js` (the CPU rig, which imports `../creature-locomotion.js`),
`bug-eyes.js` and `bug-eye-math.js` (the twelve appearances, the three mounts, and their
testable geometry),
`test-demo-sdf-bug-v2.mjs`, `test-demo-bug-eyes.mjs`, `test-demo-bug-eye-math.mjs` and
`_check_sdf-bug-v2.html.mjs` at the repo root. `bug-sdf.js` stays v1's twin and is used by v2's test only
as an independent oracle for the authored pose.

### Tuning the gait numerically

`bug-gait-objective.js` scores a gait, and `node tune-bug-gait.mjs [budget] [seed] [--freeze=a,b]` runs
`../spsa.js` against it. It is the bug's answer to `gait-objective.js` and a separate file because almost
nothing in that one transfers: its rig is a 1.8 m humanoid, its parameters are the player's speed-model
coefficients, and one of its terms is *inverted* here — it charges 8.0 for "both feet off the ground in a
walk", whereas three feet off the ground is exactly what a correct tripod does.

**Ten parameters, and two deliberate exclusions.** `maxSpeed` is a swept condition, not a parameter: an
optimiser free to choose its own speed discovers that standing still has no artifacts and wins.
`maxConcurrentFraction` is excluded because it reaches the scheduler as `floor(legs * f)`, so the objective
is piecewise constant in it and SPSA's two-point gradient is zero almost everywhere. Leaf radius is the
terrain — curvature is what makes footholds hard — and wander seeds are swept too, because the turn
pattern is what strands a foot.

**Results, at 1600 evaluations against a baseline of 1.2536 out of 4:**

| mode | best | by |
|---|---|---|
| unconstrained | **3.1304** | random search |
| `--freeze=stepDuration,stepLift` | **2.3474** | SPSA |

The unconstrained run gets there mostly by setting `stepDuration` to 0.289, near its bound — "step much
more slowly", which buys time to place each foot, scores far better, and stops the bug reading as an
insect. That is the saturation problem in concrete form: the objective has no term for "reads as a beetle"
and cannot acquire one. **`--freeze` is the mode whose output is safe to paste**, and it recovers most of
the improvement (2.35 of 3.13) from foot-placement numbers alone, chiefly a much larger vertical step
trigger (0.060 → 0.181), a tighter horizontal reach limit (0.200 → 0.131), a shorter look-ahead
(0.220 → 0.104) and a harder slow-down when pinned (0.350 → 0.126).

**SPSA does not clearly beat random search here**, which is worth stating because the sibling demo exists
to argue that it does. Unconstrained, random search wins two of three seeds; with the aesthetic parameters
frozen — a smaller, smoother subproblem — SPSA wins and random search finds nothing better than the
baseline at all. The control is what makes either claim checkable.

**Four things went wrong while building this, all found by measurement rather than review.**

1. **SPSA made literally zero progress at first** while random search improved, and the control is the only
   reason that was visible. The noise in the objective is not measurement noise, it is *condition
   variance*: a run at R=1.4/0.62 scores about 2.5 worse than one at R=4.5/0.12 whatever the gait. SPSA
   forms `(y+ − y−)`, so drawing a different condition per probe buries the gait signal, and
   `calibrateSpsa` then measured a noise sd of 0.76 and set `c` to match — perturbing every parameter by
   three quarters of its range. `createPairedSampler` shares the condition across the pair, the common
   random numbers cancel, and the difference at identical theta becomes exactly zero instead of ±0.45.
   Nothing about SPSA needed changing.
2. **`speedShortfall` measured against the wrong thing.** Against `maxSpeed` it read 0.46 on the shipped
   gait and contributed 2.75 of a 4.18 penalty — dominating the objective with a number that described the
   *steering* model working correctly, since it deliberately slows to 0.35× while turning. It now measures
   against the commanded speed, and is weighted down to 3.0 besides: pushing it rewards keeping feet on the
   ground, which is in direct tension with the tripod.
3. **The clipping term was powerless.** `clip` is a mean penetration depth normalised by leg span, and the
   depths are sub-millimetre: at the lift where a swinging foot is under the surface 20.6% of the time it
   contributed 0.011 to the penalty. The *fraction* of swing time below the surface is scale-free and worth
   1.65 at the same point. The test that failed was the one asserting the penalty pushed lift up off its
   floor — it did not.
4. **The tuner selected on a cheaper criterion than it reported.** Two shortcuts were tried for the in-run
   clean check, two seeds instead of three and then five seconds instead of seven, and each let a candidate
   win the check and then score *below the baseline* on the full reference. If the selection criterion is
   not the reported criterion, the reported number is not what was selected for.

Also worth knowing: **step lift is only constrained from below.** Clipping fires at 84.7% of swing ticks at
lift 0.0005 and 20.6% at 0.004, but is identically zero from 0.02 up — so the term is a floor and nothing
more. The module header first claimed lift was properly constrained, which was measured before the rig's
steering guard was fixed; with the body no longer turning away from pinned feet the strides shortened, the
chords dipped less, and the numbers the objective had been described by moved.

`node test-bug-gait-objective.mjs` — 84 checks, aimed at whether the objective measures what it claims
rather than at its arithmetic: every parameter must move the score, the stranding defect must be detected
(reach 6.5% → 24.4% with fast turning and no slow-down), the two corrected terms must stay corrected, and
every scored key must exist in a real metric set — because adding `clipFrac` poisoned six checks with NaN
when the synthetic objects lacked the key.


---

## `volumetric-smoke.html` — raymarched explosions in bounded volumes

Explosions rendered two ways, switchable, on the same life cycle:

- **Billboards** — what `effect-renderer.js` ships today, instanced the same way that file
  instances its own pools so the A/B is about technique and not draw-call count. Per blast: a glow
  core plus five body puffs, and ten smoke sprites — `drawExplosion`'s `SMK` constant exactly.
- **Volume** — one bounding sphere per blast, marched per covered pixel, with a short secondary
  march toward the sun for self-shadowing. Every live blast is one instance in **one draw call**.

### What it was measured against

Both existing explosions were read before this was written. They are not independent designs:
`effect-renderer.js:3` says outright that it is a port of html-game-v2's explosion look into a
stateless replication model. So the interesting question was where they have drifted.

| Layer | html-game-v2 | `effect-renderer.js` |
|---|---|---|
| Fireball core | solid sphere mesh + a pooled dynamic light | additive billboard |
| Shockwave | ground ring mesh **and** a wireframe shell sphere | 26-segment line ring + 14 radial rays |
| Smoke | 2600-slot pool of **low-poly spheres** | 260-slot pool of soft billboards, 10 per blast |
| Shrapnel | 900 instanced tetrahedra + 900-slot glow pool + trails | 12 line streaks |
| Sparks | 80 instanced cylinders | pooled points |
| Ground impact | textured additive quad gated on height | line ring gated by `nearGround` |
| Scorch / crater | none | none |
| Degrading under load | `reserveExplosionVisualTier` | silent pool overflow |

Both are approximating a volume — one with soft sprites, one with opaque spheres. The volume is
the thing they are both approximating, which is the whole argument for this page.

### The three comparisons to actually make

**Get low and look along the ground.** Fire the ground-hugging blast. The billboard pool cuts hard
straight lines where each quad meets the floor. The volume does not, because the march clamps its
exit distance to the depth already in the framebuffer:

```js
const tEnd = min(tFar, sceneDist);   // the whole soft-particle win, in one line
```

That same clamp is what makes the **ground pancake** honest. html-game-v2 has to detect that a
blast is near the ground and lay a separate flat quad for it; here the shape simply cannot reach
through the deck, and squashing the sampling space vertically does the spreading for free.

**Watch the first 0.2 seconds.** The fireball is not a second system layered over the smoke — it is
the same density field with a `heat` term that decays over the first fifth of the life, emissive on
a blackbody-ish ramp. Because the fire lives inside the density, **it is occluded by its own
smoke** as it dies. An additive billboard core cannot do that at any price; it can only sit in
front of or behind the smoke, never inside it.

**Fire the volley of six.** This is the tier system, and the reason it is worth the page.

### Cost tiering, ported from html-game-v2

When several blasts land in a few frames something has to give, and the two codebases answer
differently. `effect-renderer.js` lets its shared pools overflow silently, so a volley removes
**random sub-particles from every live blast at once** — everything gets slightly worse and nothing
looks deliberate. html-game-v2 reserves a quality per blast up front: within a 320 ms window the
first two render full, the next three medium, the rest lite. Later blasts degrade whole and
coherently while the first ones stay pristine.

The second one is clearly better, so it was extracted to `../explosion-tier.js` and covered by
`test-explosion-tier.mjs` (34 checks). **That module is the one import this page makes** — same
reason `spsa-gait-tuning.html` imports `../spsa.js`: the demo exists partly to argue for shipping
it, and a private copy would be arguing for nothing.

A raymarch has exactly one meaningful quality dial, so the tiers map onto it directly rather than
onto "how many sprites do we drop":

| Tier | What it renders |
|---|---|
| full | volume, full step ceiling, light march on |
| medium | volume, half the steps, light march off |
| lite | falls back to billboards entirely |

The per-tier step count is a runtime bound inside a compile-time loop, so fragments of a
half-resolution blast really do exit early. The saving is smaller than proportional, because
neighbouring fragments in a warp can belong to different blasts — but it is real, and the readout
reports steps summed across live blasts so you can watch it move.

### What is deliberately not volumetric

Shrapnel, sparks, embers and the shockwave ring. They are thin, fast, high-contrast and close to
sub-pixel; instanced geometry is right and html-game-v2's version of them is the stronger of the
two. Marching them would be absurd. This page does not draw them at all — it is not a complete
explosion, it is the two layers that were worth changing.

### Depth reconstruction, and the one open question

`getViewPositionSafe` and the `viewportDepthTexture` read are lifted from `projected-decals.js`
(lines 80-83 and 188-193), the one place in this codebase already proven to sample scene depth from
a TSL graph. That file's header flags one untested case: `antialias: true` plus a `PostProcessing`
stack, where the depth target is multisampled. **This demo deliberately runs `antialias: false`
with no post stack**, so it does not answer that question — it only shows what the technique buys.

The cheap way to answer it for real: `bot-viewer-v3.html` already ships `projected-decals.js` and
already exposes `?msaa=0` (line 146). If projected wound stains render correctly there, the
volume's depth clamp works there too, with no code written. `environment-viewer.html:316` hardcodes
`antialias: true`, so v3 is the right first host either way.

The "depth debug" checkbox paints the reconstructed scene distance as 1 m bands, the same sanity
check `projected-decals.js` ships; clean bands locked to the world mean depth is readable.

### Controls of note

"Step ceiling" and "Light steps" rebuild the shader graph on change (debounced 260 ms), the same
rebuild-on-structural-change pattern `post-fx.js` uses for tone mapping. Everything else is a live
uniform write. "Ground pancake" and "Mushroom cap" are the two shape terms that cost nothing per
step — they deform the sampling space rather than adding lobes.

"Smoke persistence" (0.6–14 s) is the blast envelope, and it deliberately moves **only** the tail.
How long the fire burns (`HEAT_TIME`, 0.52 s) and how fast the ball opens (`GROWTH_TIME`, 2.6 s) are
properties of the charge, so they stay on absolute time — dial persistence to 14 s and you get a
cloud that lingers, not a fireball that burns for fourteen seconds. Past the growth window the cloud
keeps expanding and rising slowly, because a long-lived plume that holds still reads as a bug. Each
blast snapshots the value at spawn, so dragging the slider never retimes something already in the
air; the auto loop refires on a fixed 2.99 s cadence, so a long setting stacks overlapping clouds
and the readout shows the overdraw that costs. At the default 2.6 s the envelope is numerically
identical to the single `LIFE` constant this replaced.

## `easyfire.html` — evaluating a third-party fire simulation

[bandinopla/threejs-easyfire](https://github.com/bandinopla/threejs-easyfire) (MIT), pinned at 0.1.7
and loaded from jsDelivr. Not vendored — loading it from a CDN is the point, because nothing here
should imply we have adopted it. This page is a harness and a stopwatch, not an integration.

**It is not an explosion renderer.** It is an Eulerian fluid simulation: velocity, pressure,
divergence, vorticity and a dye field on 3D voxel grids, advanced by TSL compute passes every frame,
drawn by raymarching the dye grid through three's `VolumeNodeMaterial`. `volumetric-smoke.html` next
door marches a closed-form density function with no state at all. That one *evaluates*; this one
*simulates*, and the difference is the entire cost story.

**Does it use our smoke?** No, and it cannot. The dye field is
`vec4(density, temperature, age, colourMass)`, and colour comes from a temperature ramp — a base
colour at temperature zero plus three flame tiers. Smoke is the cold end of that same field, not a
separate system with a seam you could feed. The panel's "Smoke and colour" section is the whole of
the control you get: the base colour is the soot, and tier 1's transition is where soot becomes
flame. Our raymarched smoke could only ever be drawn *alongside* it as a second transparent volume,
and the two would not mutually occlude.

**It does not run on the three we pin. That is the headline finding.** The app is on 0.184; this page
pins **0.185.1**, the version the library is developed against. Every symbol its bundle imports — 38
from `three/tsl`, 13 from `three`, 4 from `three/webgpu` — does exist in 0.184, which is exactly why
a symbol check was the wrong test. Two failures hid behind that clean result, found in order:

1. The bundle imports two addon modules **by path**, and `three/examples/jsm/tsl/math/curlNoise.js`
   is new in 0.185. On 0.184 it fails at module resolution, before a line of the library runs.
2. Past that, 0.184's TSL emits WGSL its shaders will not compile —
   `no matching constructor for 'vec3<u32>(vec2<f32>, abstract-float)'`, with a
   `length of parameters exceeds maximum length of function 'vec3()'` warning from the same call.
   That is a codegen difference between the two versions, not something a caller can work around.

**So adopting EasyFire means bumping three across the project first**, and that belongs in the
decision next to the frame cost. It is also why the page loads three from a CDN instead of sharing
the repo's copy: the demo runs on a version the app does not.

Every EasyFire member this page calls was likewise checked against the shipped bundle rather than
against the README, which disagrees with `llms.txt` on option names (`boundingBox` is real,
`worldGrid` is not).

**What to measure.** The three-way switch at the top is the page:

| Mode | What it shows |
|---|---|
| Scene only | baseline, with the fire pass removed from the node graph |
| Fire, sim frozen | `simulate = false` — the raymarch alone, grid drawn but not stepped |
| Fire + sim | everything |

The gap from 1 to 2 is what *drawing* costs; the gap from 2 to 3 is what *simulating* costs. Only the
second scales with grid resolution the way people expect. Take the baseline first — the readout says
so until you do.

One trap worth recording: **the raymarch-step slider has to write to the material, not the config.**
EasyFire passes `steps` into its `VolumeNodeMaterial` at construction and never reads it again, but
three re-reads `material.steps` as a uniform on every render (`three.webgpu.js:28921`). Writing
`fire.config.steps` looks correct and does nothing.

**The volume is lit, not emissive — and that is the trap.** three's `VolumetricLightingModel` does
`scatteringDensity.mulAssign(scatteringNode)` (`three.webgpu.js:29160`), so the fire is a *multiplier*
over light reaching the volume. Two rules decide what reaches it: the fire pass sets
`camera.layers.mask` from its own layers (`:40996`), so only lights on `renderLayer` (10) count; and
`if (… || lightNode.light.distance === undefined) return;` (`:29222`) skips any light without a
`.distance`, which excludes `HemisphereLight` and `DirectionalLight` outright. A scene lit only by
those renders `0 × fire = 0` — **black in every mode, unaffected by every tuning slider, and no error
anywhere**. The library's `scatteringEmissiveNode` escape hatch is unused in 0.1.7, so there is no
unlit fallback. The page therefore ships a `SpotLight` with `distance` defined and confined to layer
10, matching `demo.ts:34-51`. If you fork this wiring, that light is not decoration; it is the image.

This cost eight parallel agents and a deep one to find. Six wrong root causes came back first,
including two that argued opposite sides of the compositing line — one of them citing a confident
code comment that was itself wrong. `?volnoise=1` is *not* a control for "does the volume draw": the
noise sample goes through the same lighting multiply, so an unlit volume is black there too.

**Two further ways it draws nothing, silently.** Both were also hit here, and neither raises an error:

1. **Emission is one compute invocation per emitter vertex, and each writes exactly one voxel.** The
   emitter template's vertex count therefore *is* the emission budget. A crate-shaped box has 24
   vertices and produces no visible fire; the library's own demo burns a teapot. The template here is
   a separate invisible 561-vertex sphere, and the panel reports the count so this never hides again.
2. **`fireDensity` ships at 0.01**, and the per-vertex deposit is `uEmitDensity * 0.2` — 0.002 per
   frame against a dissipation of 0.2. Nothing accumulates. The page sets it to 0.4 at startup and
   puts it on a slider, along with emit temperature and buoyancy.

The panel also has a "show simulation bounds" wireframe, because "where is the box" is the first
question when nothing appears and the library's own `debug.renderVolumeBox` is construct-time only.

**Status: measured.** Fire renders, and the cost A/B has been run. Numbers below are GPU timestamp
queries (`trackTimestamp` + `resolveTimestampsAsync` for RENDER and COMPUTE), not CPU submission
time — an early version of this page reported the latter and it was meaningless, since WebGPU
submission returns long before the GPU does the work.

**One fire, 6 m box, 64³ physics / 100³ render, 22 steps, filling a good part of the screen:**

| | GPU ms | over baseline |
|---|---|---|
| scene only | raymarch 0.59 | — |
| fire drawn, sim frozen | raymarch 5.44 | **+4.85** |
| fire + simulation | raymarch 5.37, fluid 2.03 | **+6.55** |

**The raymarch costs nearly three times what the fluid simulation does** (4.85 vs 1.70 ms). That is
the opposite of the intuition the technique invites — the Eulerian sim with its 11 3D textures is the
cheap half; drawing it is what hurts. It also means the cost scales with **screen coverage**, not
grid resolution, so the physics-grid slider is not the dial that matters.

**6.55 ms is 39% of a 60 fps frame for a single fire.** Two and a half of them consume the entire
budget. Against `bot-viewer-v3`'s measured ~37 fps at 90 bots (~27 ms/frame), there is no room at all.
The verdict for this project: **not viable as a general effect**, plausible only as one hero fire in a
scene with real headroom, and then only after measuring it at realistic on-screen size. Combined with
needing a three bump to 0.185, that closes the evaluation.

"Fire only" mode is a diagnostic, not a measurement: without the scene's depth the march cannot
terminate early, which is why its raymarch figure (9.57 ms) runs well above the composited one.

## The two borrowed-asset demos

`wildlife-mobs.html` streams every model from
[proofofplay/piratenation-art](https://github.com/proofofplay/piratenation-art), and
`pose-retarget.html` can pull clips from there too. It is licensed **CC0-1.0** — public domain,
commercial use, no attribution required. Nothing is vendored here; every model is fetched at runtime.

**The access fact that makes them possible.** The assets are in Git LFS, so
`raw.githubusercontent.com` returns a ~130 byte pointer file instead of the model. The LFS media host
serves the real bytes, and answers with `Access-Control-Allow-Origin: *`, so the browser can fetch
them directly with no proxy and no local copy:

```
https://media.githubusercontent.com/media/<owner>/<repo>/<branch>/<path>
```

**The upstream folder names are booby-trapped.** `Mob Enemies ` has a trailing space, and so do
`Anglerfish Water `, `Harpy Air `, `Trilobite Fire ` and others, while their siblings do not.
Trimming any of them gives a 404. `test-wildlife-mobs.mjs` resolves all **146** rostered paths and
asserts that trimming breaks one, so nobody tidies the table later.

---

## `wildlife-mobs.html` — CC0 mobs as wildlife

A herd of voxel sea creatures wandering a clearing, streamed live from GitHub. Pick a species and an
element, set a population, click one to make it attack.

**The whole bestiary is 25 families and 146 variants**, not the handful the first pass found: fish
(anglerfish, blowfish, hammerdead shark), tentacled masses (giant squid, charybdis, foam monster,
mutant jellyfish), winged (wyvern, harpy, hippogriff), quadrupeds (hexa croc, sea lion), a whale, an
insect (megasquito), amorphous things (mist monster, shipwrecked spirit, kelpling, living wave), and
mecha and undead reskins. "Load one of each" sweeps all 25.

The upstream naming follows no convention at all — some variants are named for the creature
(`Anglerfish Air`), some by voxel-grid id (`mob_6x6_mechacharybdis_air`), some nest a display name a
level deeper, some are just an affinity (`Air Affinity `). The typos are upstream and load-bearing:
`Shipwrecked Spirit Lighting ` and `Slimy Kepling`. `Raw Files`, `Deprecated`, thumbnail folders and
the `VE` VoxEdit sources are excluded.

**Why this is the easy half.** The mobs are **not skinned** — no `skins` array, no `JOINTS_0` /
`WEIGHTS_0`, and every animation channel targets translation/rotation/scale on a plain node. They are
rigid part hierarchies driven by node-transform keyframes, which is exactly what our own bodies are
(`bot-limb-map.js:32` calls our parts "transform-only Object3D in instanced mode"). There is no rig to
convert: `GLTFLoader` plus `AnimationMixer` plays them natively in r0.184. Every creature ships the
same three clips, `idle` / `hit` / `attack`.

Because they are unskinned, instances are plain `.clone()`s sharing geometry and materials, and a
per-instance `AnimationMixer` still resolves every track — the clips address nodes by name and
cloning preserves names. A skinned model would need `SkeletonUtils.clone` instead.

**What the demo refuses to hide.** These models carry **one material per mesh part** — 35 on the
Anglerfish, 66 on the Wyvern. The draw-call counter climbs in proportion to the herd and turns amber
past 600. That is the batching problem `body-part-batches.js` already solves for our bots, and it
would have to be solved again here before any of this ships.

**Open question this cannot answer.** Whether the chunky voxel art reads acceptably next to the neon
and eco-brutalist bot themes is an art call. Look at it and decide.

---

## `pose-retarget.html` — driving the real soldier from borrowed clips

This targets **the actual game body**: `createProceduralPlayerBody` from `../player-procedural-body.js`
with `setBotBodyKind('soldier')` and `botDesignForRole(...)` from `../bot-body-design.js` — the same
soldier the bot viewers and the environment viewer build, with its five roles in a dropdown. Like
`spsa-gait-tuning.html`, it imports repo modules deliberately: a private copy would prove nothing.

Both modules take `THREE` as a parameter and need no renderer, which is why the demo can drive them
from a WebGPU page and why `test-pose-retarget.mjs` can build a whole body in Node.

**The seam is `setRagdollPose`, and it takes POSITIONS.** It already exists for the ragdoll and
accepts sixteen joint world positions — `head, neck, chest, pelvis, shoulderL/R, elbowL/R, handL/R,
hipL/R, kneeL/R, footL/R`. That is a better seam than rotations for borrowed animation: retargeting
rotations between two skeletons means reconciling bone axes, rest orientations and differing joint
counts, whereas a position lands the joint where the clip put it and our IK owns everything between.

**Two clip sources, and the better one was already in the repo.**

- **KayKit** by Kay Lousberg (CC0-1.0), sitting in `../claudecraft-assets/`. Nine characters, a clean
  23-joint rig, and **22 clips each** — Idle, Walking_A, Running_A, Running_Strafe_Left/Right,
  Walking_Backwards, Death_A, Hit_A, Block, 1H/2H melee, 2H_Ranged_Shoot, Jump_Idle. The rig even
  carries `handslot.l/r` weapon sockets. Local, so it loads instantly and works offline.
- **Pirate Nation** (CC0-1.0, streamed). 16 joints, 32 clips, strong on personality — three idles,
  waves, a celebration, a surprised reaction, five dances, pushups — and weak on combat.

Both are read through one canonical 15-slot skeleton, so the retarget never learns a rig's private
names. Resolution is EXACT match on a normalised name, deliberately not the fuzzy scoring in
`body-preview-v3.html:1283` — fuzziness is what would let `LeftHandThumb1` answer to `lefthand`.
Alias order matters: KayKit ships both `wrist.l` and its child `hand.l`, and our arm chain ends at
the wrist. The same table swallows Pirate Nation, KayKit and Mixamo naming.

**The mistake worth recording: scaling by one factor does not work.** The first version matched the
donor's leg to ours and scaled every joint about the hips. Measured headlessly against the real
KayKit knight that is ×2.96, which put the head at **3.29 m** and the feet **1.55 m** apart. The
donors are chibi — short legs, big head — and no single factor fixes a proportion mismatch.

What works is taking only the **directions** from the clip and stepping **our own** bone lengths
along them:

```js
knee = hip  + dir(theirHip  -> theirKnee) * ourThighLen
foot = knee + dir(theirKnee -> theirFoot) * ourShinLen
```

The result carries our skeleton's dimensions exactly and the donor's angles exactly. Re-measured on
the same clips: head 1.68–1.79 m, thigh and shin equal to `limbLengths` to 1e-9, feet planted. Trunk
offsets have no counterpart in `limbLengths`, so they take one factor recovered from documented
constants — `legLen / BODY_DESIGN_DEFAULTS.legLenRatio` gives back the design height.

**Three things that were verified rather than assumed.**

- **The side mirror reaches `setRagdollPose`.** `bot-limb-map.js:10-13` warns that
  `parts.arms.left` is the visual left wired to the internal `arms.right`. Building a body and
  feeding it a pose shows a joint handed to `handL` arriving at `joints.rightHand`. Because limbs
  are placed by position this never crosses the arms — the pose still looks right — but it silently
  decides which limb's gear, holster and weapon follow. Hence a "swap sides" toggle, not a guess.
- **The KayKit GLBs are meshopt-compressed.** Without `setMeshoptDecoder` `GLTFLoader` throws
  outright and none of them load. `body-preview-v3.html` already does this for the same files.
- **A death animation putting the head at 0.69 m is correct, not a bug.** It was flagged by a
  too-strict "human height" assertion before the clip name was read.

### Making a cartoon clip read as a soldier

A faithful retarget of a KayKit walk is still a KayKit walk, and on a 1.8 m soldier it reads as a
pantomime sneak. Four post-passes fix that, all live controls rather than baked constants. Each one
moves an endpoint and re-solves the middle joint by two-bone IK, so bone lengths survive — worst
measured error over 240 frames of `Walking_A` is 3e-15 m.

| Pass | What it fixes | Measured on `Walking_A` |
|---|---|---|
| **Bob damping** | Cartoon hip pumping | hip swing **224 mm → 99 mm** (56%) at the 0.6 default |
| **Arm inset** | Arms held out as if the body were round | hands **32%** closer to the mid-line at 0.45 |
| **Weapon in hand** | No weapon at all | hands blend onto grips; at blend 1 the clip drives only legs and torso |
| **Sling** | Weapon needed, but hands wanted free | weapon rides the back, arms untouched |

**Bob damping is the interesting one.** 224 mm of hip travel on a 1.8 m figure is roughly five times
a real walk. Rather than flattening the curve and letting the feet slide, the stance height is pulled
toward its own running mean and **the knees absorb the difference with the feet left exactly where
they were** — which is what real legs do. Pushing the slider to 1.0 only reaches 60%, because the
lift is clamped per leg so a damped hip can never out-reach thigh + shin. That ceiling is physical.

**The sling is what keeps the whole 22-clip library usable.** With the weapon on the back there is no
arm pose to blend and nothing to author, so every hands-free clip — including the dances, the sits
and the cheer — plays unmodified on an armed soldier.

**The weapon is mounted by the game's own pipeline, not by anything this demo invented.** The first
version derived a grip from a bounding box and produced an enormous CZ, pistols inside the torso and
everything backwards. Every step of the real path was already in the repo:

- `getWeapon(id)` (`weapons.js`) carries the model path and the authored `thirdPersonHold`
  `{position, rotation, scale}` tuned in `body-preview.html`.
- `normalizeBotWeaponModel` (`bot-viewer-v3.html:2150`) rotates the **longest axis onto Z**, scales
  it to the target size, and **recentres** the model. The CZ's raw bbox is 8.2 × 173.3 × 33.6 —
  longest on **Y** — so code that assumes a forward axis without this draws it sideways, and the
  missing recentre is what put weapons inside the torso.
- **The third-person target size is a flat `0.62` for every weapon — not `viewTargetSize`.** That
  field is the *first-person* view-model size, and `weapons.js:80` says so in as many words: "the
  game normalizes the third-person GLB to the preview's 0.62 target (NOT viewTargetSize) so the hold
  scale, pose offsets (lowReady etc.), and baked anchors all read identically." Reading
  `viewTargetSize` here drew the **CZ 2.10× oversized**, the M24 2.50× and the pistols 1.53×, and
  displaced every baked anchor by the same factor so the hands reached for grips no longer on the
  gun. Only the RPG looked right, because it has no `viewTargetSize` and fell through to 0.62.
- `bakeBotWeaponAnchors` (`bot-viewer-v3.html:2166`) moves `weapon-anchors.json` from raw-GLB space
  into that normalized space. Read raw against raw meshes the spans look inconsistent by 1.4×–125×,
  which is what made them look broken; they were never meant to be read raw, and never meant to set
  scale — the normalization target does that.
- The mount is v3's **four**-node rig (`bot-viewer-v3.html:2243-2250`): `weaponRig` carries world
  position and **body yaw only**, `weaponAdjust` carries the hold, `weaponFrame` is a **fixed 180°
  spin**, and `weaponView` carries the pose from `weapon-poses.json`. Dropping the middle two is not
  cosmetic — the frame alone displaces the weapon 2.66 m. v3's comment is explicit that mounting to
  the torso double-counts stance and puts the gun under the floor, so `weaponRig` sits in the
  ground-anchored frame at `feetY + 1.5`.
- **`weaponRig`'s local +Z is the direction the soldier faces**, and copying `rdBasis` to get it is a
  trap. `rdBasis` (`player-procedural-body.js:1934`) builds `forward = cross(up, right)`, but that
  result is the body's *local +Z*, and the eyes sit on local **−Z** (`:1932`) — so matching it aims
  the mount out of the soldier's back. The facing is `cross(right, up)`, measured off a posed rig
  (the head's world quaternion applied to `(0,0,-1)`, dot 1.000) rather than argued from the source.
  `body-preview-v3.html:892` states the convention outright: `weaponFrame` is the "fixed 180deg
  spin: camera-forward (-Z) -> body-forward (+Z)".
- **Grip anchors come back in world space and must be converted before use.** The demo builds the
  body with `scene: soldierRoot`, offset so the soldier stands beside the donor, so every joint in
  `pose` is soldierRoot-local while `matrixWorld` is not. Blending a world-space grip into a
  local-space hand put the target a full metre to the side — further than the 0.648 m arm — so the
  reach clamp pinned the hand at full extension and the arms never went near the gun, however well
  the weapon itself was placed. The readout now prints shoulder-to-grip distance against arm reach,
  so a hand that falls short says so instead of just looking wrong.
- **`feetY + 1.5` is a relationship, not a constant.** A standing soldier's shoulders measure at
  `feetY + 1.656`, so v3's mount sits **0.156 m below the shoulder** — a carry. This demo rescales
  the trunk to fit the donor clip, so its shoulders land lower and the copied 1.5 came out *above*
  them: the gun rode overhead and both arms went straight up chasing it. `measureMountOffset` now
  runs the rig's own gait for 240 frames at build time, reads where its shoulders actually settle,
  and the mount keeps that shoulder-relative offset. The slider is a **trim** defaulting to 0.
- The gun GLBs are **Draco-compressed**; without `../draco-loader.js` `GLTFLoader.parse()` throws and
  nothing draws at all. That was why the weapon was invisible before.

The hands then follow the weapon, which is the direction the game works in. v3 does it through
`weapon-pose-controller.js` driving `setArmTarget`; this demo blends the **baked grip anchors** into
the hand positions instead, because **`setArmTarget` is inert under `setRagdollPose`** — arm targets
are only consumed by `solveArm` on the `update()` path.

**What `setRagdollPose` leaves undone.** It is the death-pose path, and two omissions are visible on a
geared soldier. `poseLimb` never calls `jointFrame`, and `player-procedural-body.js:1370-1373` already
documents why that matters: `setFromUnitVectors` "gives +Y along the bone but an ARBITRARY ROLL … that
is why outboard leg pistons rendered front-centre." Gear is parented to those joint nodes
(`:1058`), so elbow and knee plates tracked position while keeping a stale rotation — the floating
pucks. The feet had the same problem with no orientation at all, where `solveLeg` sets
`foot.quaternion = groundQ × orientation` (`:1378-1379`). `finishRagdollPose()` now replicates both
passes exactly after each `setRagdollPose` call.
**Still open.** Root motion is discarded — the pose is planted every frame, so `Walking_A` walks on
the spot. Consuming that travel is what a real port has to add. Nothing here is wired into the game.

---

## `spsa-gait-tuning.html` — letting an optimiser tune the real gait model

The odd one out here: not a rendering technique, and the only demo that imports from the repo
(`../gait-objective.js`, `../spsa.js`). It comes from
`docs/research/quantum-software-transferable-techniques.md`, item 2.

**The technique.** Variational quantum algorithms cannot get clean gradients, because every
evaluation is a noisy sample off real hardware, so that field standardised on **SPSA** —
simultaneous perturbation stochastic approximation. It estimates a descent direction from exactly
**two** evaluations per iteration no matter how many parameters are involved. Qiskit ships it as the
default optimiser for VQE.

**Nothing on this page is a stand-in.** An earlier version scored a toy kinematic quadruped invented
for the demo; it was replaced because a demo that argues for a technique on fake mechanics argues
for nothing. Every walk here runs `stepGait` from `player-procedural-body.js` — the same scheduler
the player body uses in game, which is THREE-free by Contract 3 precisely so it can be driven
headlessly like this.

- **Tuned:** `GAIT_SPEED_MODEL`, the least-squares speed→gait fit authored in `body-preview.html`,
  plus the two speed-independent constants `stepGait` reads (`triggerDistance`, `stepOverlap`).
- **Baseline:** that same model at its shipped coefficients — what the game walks with today.
- **Measured:** real foot states. Swing foot through the ground, planted foot dragged outside leg
  reach, both feet airborne, stride asymmetry and irregularity, excess lift, jitter-short steps.

**Not tuned, deliberately.** `GAIT_DEFAULTS.lookAhead` is declared and read nowhere in
`player-procedural-body.js` — a dead parameter, so optimising it would move a number that changes
nothing. `standSpeed` and `teleportDistance` are inert while walking. `pelvisHeightRatio` **is**
tuned, unlike in the first version: `update()` writes it from the speed model every frame, and it
decides whether a leg can reach the ground at all.

**The defect the page is about.** A step's landing point is chosen when the foot *lifts* and is
never revised. During the swing the hip keeps moving, so the foot lands behind where it aimed.
Traced at a dash, the planted foot runs from **0.36 m to 1.46 m behind the hip and is never once
underneath it**. `aheadDist` was meant to cover exactly this — it is one step of hip travel — but
`constrainFootTarget` then clamps the target to `workspace.forward` (0.62 m) and discards most of it.

That is not cosmetic. Legs are solved by `solveTwoBone`, an analytic two-bone IK that clamps the
foot to 0.999 of full extension along the hip→target line. There is no FABRIK on the legs and
nothing stretches the bones, so an unreachable target means the **drawn** foot is not where the
simulation put it, and a planted foot that moves is a foot skating across the ground. The
scheduler's workspace cannot catch it either: `maxReach` is a purely horizontal bound that never
sees the drop to the ground. This replaces an earlier note here which guessed the rig might absorb
it via "FABRIK and body settle" — there is no FABRIK in the leg path, and the page now scores it.

**Lean into step.** The demo hands the scheduler a *balance point* (`hip + lead` along the heading)
instead of the pelvis; the rest anchor follows whatever hip it is given, so `stepGait` is unchanged.
`lead = leadScale × speed × effectiveStepDuration` — a fraction of the hip travel the foot has to
catch up on. An earlier version projected the torso lean instead, and that was measurably the wrong
quantity: `torsoLean` saturates at 0.20 rad, so even at its slider maximum it offered 0.32 m at
sprint speed where the requirement is about 0.9 m. `leadScale` defaults to 0, reproducing current
behaviour exactly. The green dashed marker on screen is the balance point.

At the shipped coefficients it takes the clean score from **2.486 to 3.871** and cuts the planted
foot's overshoot at a dash from **0.184 m to 0.010 m**. The optimum is interior, about 0.75, and it
moves with `stepOverlap` — 0.75 at overlap 0, 0.54 at `bot-viewer-v3.html`'s 0.22 — because an
overlapped step shortens the stance phase. The **"Lean into step"** slider applies to the *top*
walker only, so you can A/B your own value against whatever the search chose for the bottom one.

**What the search finds — and the result is that the shipped fit was already good.** Searching all
eleven parameters scores about **3.2**; tuning the lead alone scores **3.87**. The least-squares fit
authored in `body-preview.html` did not need changing; the only thing missing from it was the lead.
That is why `GAIT_MODELS.tuned` in `player-procedural-body.js` ships the shipped coefficients
unchanged with a lead term added, rather than a new set of numbers.

**Three objective exploits had to be closed to get there**, each of which scored a visibly bad gait
as near-perfect. Measuring cadence from the *configured* `stepDuration` instead of the effective one
— the search set one to its maximum and drove the other to the floor through `maxStepDistance`,
scoring an 8 Hz shuffle at 3.99. Loose pelvis bounds — it squatted to 0.40 of body height. And
penalising a flight phase at running speed, which punished the `stepOverlap` v3 was deliberately
tuned to; a run has a flight phase by definition, so `airborne` now fades out between 2 and 3 m/s.

**The limit no coefficient can fix.** This rig steps about twice as fast as a human — 3.75
footfalls/s at 1 m/s advancing 0.27 m each, against roughly 1.8 and 0.55 for a person. Forcing human
cadence measurably makes slide *worse* (0.455 m against 0.269 m at sprint), because longer ground
contact drags the foot further behind a hip whose leg spans only 0.35 m horizontally. The shuffle is
how this geometry buys low slide. Cadence is therefore scored as a don't-regress rule against the
shipped model rather than against an absolute target, and the real constraint is that the legs are
short for the hip height.

**Why legs turn red.** Body proportions come from `BODY_DESIGN_DEFAULTS` (leg 1.116 m, thigh 0.580,
shin 0.536) rather than being guessed — an earlier pass guessed two equal 0.5 m segments and drew
every leg overstretched. Bone lengths do **not** scale with body height (they are built from a
function-local `H = 1.8` for every body) while the pelvis and the workspace both do, so above
**1.895 m** a standing leg cannot touch the ground at all. The height sweep deliberately reaches
past that cliff instead of avoiding it.

**One honest limit that remains.** Step lift is only weakly constrained — the clipping term that
should push it up is small, so the objective barely cares where lift lands even though a floaty walk
is obviously wrong to look at. Measurable artifacts are not the whole of what an eye rejects, which
is why the tuned model ships behind an A/B dropdown rather than as a swap.

**Controls.** The two marked with a green dot are live and never interrupt a run: **Preview speed**
retunes both walkers in place through `cfgForSpeed`, so the stride, cadence and lift visibly change
as you drag it, and **Iters/frame** is the cost dial. The rest — budget, sample walk length, seed,
race — rebuild the search, but keep running if it was running. An earlier build paused on every
one of these, which made the sliders look inert.

---

## Status

The rendering demos are exploratory and none is wired into anything.

`spsa-gait-tuning.html` is a different case, and it has now been acted on. The harness was rebuilt
on the real rig — the scaled leg workspace, the speed-varying pelvis, the real hip socket, a body
height sweep and the real bot speeds — and the search was run to convergence by `node tune-gait.mjs`.
The outcome went into `player-procedural-body.js` as `GAIT_MODELS`, selectable from the **Gait
model** dropdown in `bot-viewer-v3.html`'s movement section.

`GAIT_SPEED_MODEL`'s coefficients are **unchanged**, on purpose: the eleven-parameter search scored
worse than adding a single lead term, so the tuned bundle is the shipped fit plus
`stepLeadScale`. It ships as an A/B option rather than a swap because the objective measures
artifacts, not taste, and the eye is still the judge.

`sdf-creature.html` and `volumetric-smoke.html` have no Node test (the TSL graphs were built
headlessly against `node_modules/three` during development to check the node API, but that check lives
in no committed file), and their numbers — step counts, densities, palette — are authored by eye
rather than measured.

The two borrowed-asset demos do have tests, both passing:

```
node test-pose-retarget.mjs     # 21 checks: slot resolution across 3 rigs, the setRagdollPose side
                                # mirror, exact joint placement, planting, and the direction-based
                                # reconstruction on a synthetic chibi donor
node test-wildlife-mobs.mjs     # all 146 asset paths, unskinned-ness and clip names across 6
                                # archetypes (flyer, quadruped, tentacled, insect, amorphous, fish)
```

Both skip the network-dependent half rather than failing when offline. `test-pose-retarget.mjs`
builds a **real soldier body in Node** — the modules take `THREE` as a parameter and need no
renderer — which is how the side mirror and the joint-placement guarantees are pinned down rather
than assumed.

What no test covers is how any of it *looks*, which is the part that decides whether this is worth
porting. **Neither demo has been opened in a browser.** Known gaps that only the eye can settle:
whether the voxel bestiary sits acceptably beside the bot themes, and whether a chibi-authored walk
reads as a soldier's walk once it is on our proportions.

One measurement trap worth recording from building these: `Quaternion.angleTo` is `2·acos(|dot|)` and
is ill-conditioned near zero, so a genuine 1e-8 component error reports as ~1e-4 rad and looks like a
real mismatch. Compare components, not angles, when checking that two rigs agree.

Also worth knowing before writing any other addon-based test here: the local `node_modules/three`
ships **empty addon stubs** — `examples/jsm/loaders/GLTFLoader.js` is 0 bytes — so headless GLB work
needs the CDN copy.

`spsa-gait-tuning.html` keeps its logic in two tested modules rather than in the page:

```
node test-spsa.mjs              # 41 assertions on the optimiser module
node test-gait-objective.mjs    # 52 assertions on the scoring harness
node test-player-body-gait.mjs  # 19 assertions on the scheduler both of them drive
```

The optimiser tests cover gain schedules, the two-evaluations-per-iteration claim at n=2/12/60,
gradient direction against a known slope, convergence on noiseless and noisy objectives, mixed-scale
normalisation, bounds on both the iterate and every probe, seed reproducibility, and the n=20 race
against finite differences and random search. The harness tests assert that `cfgForSpeed` reproduces
the shipped `gaitForSpeed` exactly, that the dead `lookAhead` parameter stays out of the tunable set,
and — one per term — that each penalty actually fires on something, since a penalty that never fires
constrains nothing.

Only the drawing and the DOM wiring are untested. Those were checked by parsing the module script and
confirming every `getElementById` resolves, not by opening the page.

Beyond those, the retarget loop was run headlessly against the real file — real `GLTFLoader`, real
`AnimationMixer`, real clips, textures stripped so no image decoder is needed. Over 60 frames of
`04_Walk` the retargeted root-relative orientations match the source to a worst quaternion component
delta of 1.5e-8. That run is what caught both the `sanitizeNodeName` bug and the placement-vs-length
bug; it lives in the scratchpad rather than the repo because it needs the CDN copy of `GLTFLoader`
(the local `node_modules/three` ships **empty addon stubs** — `examples/jsm/loaders/GLTFLoader.js` is
0 bytes, which is worth knowing before writing any other addon-based test here).

One measurement trap worth recording: `Quaternion.angleTo` is `2·acos(|dot|)` and is ill-conditioned
near zero, so a genuine 1e-8 component error reports as ~1e-4 rad and looks like a real mismatch.
Compare components, not angles, when checking that two rigs agree.

What no test covers is how any of it looks, which is the part that decides whether these are worth
porting. **Neither demo has been opened in a browser yet.**

---

## `flight-sim.html` — one rigid-body core, three airframes

Groundwork for `docs/flight-harness-plan.md`, which argues that **drones, birdlikes and planes are
three different physics rather than one model retuned**, and that the shared part underneath is a
rigid body with pluggable force generators. The page exists to test that claim before anything is
written into `environment-viewer-v2.html` or `bot-viewer-v3.html`. Fly all three back to back: if
they feel like three vehicles the split is right, and if they feel like one vehicle with different
numbers the plan is wrong and is much cheaper to fix here.

The physics is descended from `G:\My Drive\Scripts\html game\html-game-v2` (`src/game/main.js:1345-1600`
and `src/game/config.js:99`), which already had angle of attack, lift, four-term drag and a stall
model. What is new is the conversion from **camera-directed glide** — look somewhere and fly there —
to **stick-flown attitude**, plus the drone and bird airframes, which have no ancestor in that repo.

|  | **Plane** | **Drone** | **Birdlike** |
|---|---|---|---|
| Thrust | Along the nose | Along body up, vectored by tilting | Impulsive, on the wingbeat |
| Lift | Wing at AoA | None — thrust carries the weight | Wing at AoA, low wing loading |
| To move forward | Point the nose, add power | Tilt | Flap, then glide |
| Hover | Impossible | Native | Briefly, at high cost |
| Control | Rate command, authority scales with dynamic pressure | Attitude command, self-levelling, authority constant | Rate command plus flap; wing sweep morphs area |

Everything else — drag, gravity, ground contact, terrain collision — is shared. Forces integrate
onto velocity; attitude is a quaternion driven by commanded **body rates with first-order lag**, not
by torque integration. That is the arcade-leaning half: real energy management and a real stall
without an inertia tensor. Lift is `0.5·rho·V²·S·Cl` and drag carries an induced term in `Cl²`, so a
hard turn costs speed with nothing scripting it.

**What to try.** Trim the plane and let go of the stick — it holds altitude. Haul the nose up at idle
power and watch the AoA readout run past the stall angle, the controls go soft, and the nose fall
through. Bank hard and watch the energy number (height plus speed expressed as height) drain. Then
switch to the drone and notice that none of that applies: tilt to move, level to stop, and no amount
of slow flight causes a stall. Then the bird, which cannot hold height without spending stamina.

**Everything is SI.** That is deliberate — the units pass is the single most likely thing to make the
shipped version feel wrong, since the source repo's numbers (cruise 34, stall 30, cap 152) are in its
own world scale. Here the plane trims at 105 m/s, tops out near 207 m/s in level flight, and stalls
around 27 m/s; the drone hovers at 36% throttle; the bird cruises near 19 m/s.

**Also answers the plan's Phase 0 questions.** Terrain is five camera-snapped clipmap rings out to
8 km, displaced in the vertex stage from an analytic height field, so it can be checked at 250 m/s
and 3 km up. The cloud deck sits at a real altitude of 1400 m rather than being locked to the camera,
so you can climb through it and look down.

`heightAt()` (JS, drives physics) and `tslHeight()` (TSL, drives the vertex stage) are the same
function written twice and **must be edited together** — the same hazard as `forest-cull.js`,
`light-cluster.js` and `post-grade.js` in the workspace proper.

### Sides, ground targets, audio and volumetric blasts

**Teams.** Every flyer carries a team. You and two allies are blue; two bandits, a drone and a bird
are red, along with every ground site. Locking, gun rounds and missile blast radius all check team,
so friendly fire is impossible by construction rather than by the AI being careful.

Ally *support* is the interesting part, and it is one line: when an ally scores potential targets it
multiplies the score by 0.4 for anything currently locked onto a team mate. That means allies leave
the nearest bandit alone to go after the one on your back, which is what support means in a fight.
Turning off "enemies hunt you" does not make the enemies idle — it removes you from their target
list, so they go and fight your allies instead and you can watch a dogfight you are not in.

Friendlies draw as circles, hostiles as squares, so the shape reads before the colour does.

**Ground targets.** One base cluster: a radar, two SAMs and three AA guns, each destructible with a
distinct HUD glyph — a dish arc, an upward triangle, a chevron pair.

- **Radar** has no weapons. It is the site that makes the others dangerous: while it lives, the SAMs
  and AA see you at full range; kill it and every other site's reach drops to 45%. That makes it a
  target worth prioritising rather than a decoration.
- **SAM** launches the same guided missiles you carry, out to 5.2 km, with a 900 m minimum range so
  you can get underneath it, and a 7.5 s reload.
- **AA** fires led bursts inside 1.5 km at 9 rounds a second. Loitering over one kills a plane in
  2.4 s.

The AA lead is worth a note. The obvious version — aim where the target will be after
`range / muzzle` seconds — misses by 41 m against a 210 m/s crosser at 900 m, because leading pushes
the aim point further away, which lengthens the flight, which moves the aim point again. Iterating
the time of flight three times and compensating for shell drop brings the worst case to 2.9 m. Both
numbers are measured.

**Audio.** Positional gunfire, explosions, missile launches and impacts, plus a generated lock tone,
launch warning, engine and wind. The lock tone in particular does real work: it tells you when the
missile will take the shot without making you look away from the target.

Every sampled sound is **borrowed** from this workspace's `sfx/` library and is listed by path in
`BORROWED_SFX` with a comment saying exactly that. `sfx/README.md` records no licence or provenance
for any of them, so they are unlicensed placeholders — fine locally, not fine to ship. Everything
generated by oscillator is ours and is marked as such. This is the one place the demo reaches
outside its own file; it is an asset fetch rather than a module import, so the isolation rule still
holds, and away from the workspace the sim simply runs silent.

**Volumetric explosions.** Craft kills now use the bounded raymarch from `volumetric-smoke.html` —
one bounding sphere, marched per covered pixel, with a short secondary march toward the sun for
self-shadowing, so a fireball has a lit top and a dark underside that a camera-facing sprite cannot
fake. Sprites stay for debris, small hits and trails.

One deliberate change from the source. That demo clamps the march at whatever solid geometry already
wrote depth, via `viewportDepthTexture`, and its own header flags the untested case: a multisampled
depth target — which is exactly what this page has, since it runs `antialias: true`. Rather than
gamble, the march is clamped against an analytic **ground plane** taken from the terrain height under
the puff, solved in closed form. Blasts are tens of metres across against terrain features hundreds
of metres wide, so locally flat is a good approximation, and it costs one height evaluation per
fragment instead of a depth read.

The honest cost of dropping the depth read: `depthTest` is off, so a fireball behind a ridge draws
over the ridge. Blasts last about two seconds so it is rarely on screen, and the sprite path is still
there behind the toggle to compare against.

**Checked headlessly**: no flyer ever targets its own side, allies really do prefer the aircraft
attacking the player, friendly fire is impossible for a bullet by construction, disabling "enemies
hunt you" leaves them fighting allies rather than idling, the AA lead lands within 3 m across four
range and speed combinations, and the SAM and AA envelopes leave a real gap to fly through.

**Still missing**: nothing shoots back at the ground sites except you and your allies' guns, sites do
not repair or respawn, there is no bombing or ground-attack ordnance, and the AI still does not use
terrain for cover.

#### The threat warning is two sounds, not one

Being *locked* and being *shot at* mean different things to a pilot, so they sound different.

- **Locked** — a low siren sweeping slowly between about 150 and 240 Hz. Unpleasant, not urgent:
  you have seconds, and the answer is to break the lock. Fires when any hostile holds a full lock on
  you, or when a SAM site is tracking you (the HUD says `LOCKED` or `SAM LOCK`).
- **Missile inbound** — the siren stops and a beep takes over, quickening as the missile closes,
  going solid in the last half second. The rate carries the time to impact, so you can hear how long
  you have without reading anything. Measured cadence on a 3.2 km tail chase: 1.5/s at launch,
  2.9/s at 1.5 km, 6.2/s at 735 m, 13.9/s at 327 m, solid from 0.5 s out.

Two things had to be fixed to make that cadence behave, both found by simulating a closing missile
rather than by listening:

1. **Time to impact is not monotone.** Near a near-miss the closure speed collapses, so `range /
   closure` climbs and the warning *relaxes* at the exact moment it should be screaming — measured
   widening from a 0.089 s gap back to 0.65 s. The rate is now driven by the smaller of the
   time-to-impact and raw-range estimates, and then ratcheted so it can only ever speed up.
2. **A pure ratchet screams forever.** A guided missile that overshoots keeps tracking while opening
   the range, and a one-way ratchet would hold the warning at maximum indefinitely. The ratchet now
   only holds while the range is shrinking; once the missile is opening, the rate winds back down.

#### And a third sound for getting away with it

The beeping stopping is not information. It could mean the missile lost you, or it could mean you
have died, or it could mean the sound broke. So a miss now gets its own cue: the two-note cabin
chime an airliner plays for an alert, a struck `ding-dong` falling a fifth from G5 to C5. It is soft
sines with a quiet octave on top, deliberately unlike the square-wave warning it replaces, and the
fall in pitch is what makes it read as *resolved* rather than as one more thing going wrong.

It fires when a missile that was tracking you stops tracking you while you are still flying — burnt
out, hit the ground, went for a flare, or fused far enough away to do nothing. Three cases it
deliberately does **not** fire on, each of which is a way of pretending you got away with something
you did not:

- The blast damaged you. That is a hit; the missile flags it and the chime is suppressed for that
  frame.
- You are dead. The threat clears when you do, and that is the loudest possible false positive.
- Two missiles back to back. The threat never returns to null between them, so there is no chime
  until the second one also misses. You never got away in between, so you do not get told you did.

The one ordering detail that matters: the "did I have a threat last frame" read has to happen
*before* the loop that clears every flyer's threat, which is the only thing still holding last
frame's value. Reading it a few lines later — the obvious place, right next to where the threat is
reassigned — gets `null` every time and the chime never plays at all.

### Enemy respawn, and a base with nothing guarding it

Two toggles' worth of change, both aimed at the same gap: the demo had no way to *finish* anything.

**`enemy respawn`** gates whether hostiles come back. Allies and you always respawn, so turning it
off gives you a sky you can actually clear rather than a war of attrition you slowly lose; the HUD
counts down `BANDITS n` and then says `SKY CLEAR`. Two separate code paths respawned an AI — a
2.5 s crash timer inside the AI driver and a 4 s dead timer in the frame loop — and gating only one
of them would have looked like the toggle worked until an enemy happened to crash instead of being
shot down. Both go through one `mayRespawn`.

The same toggle now rebuilds destroyed ground sites after 30 s, which closes a gap flagged when the
sites were built: previously nothing on the ground ever came back, so a long session ended with an
empty map either way.

**Undefended structures.** Three new site kinds with no weapons — an HQ block, two hangars and a
pair of fuel depots — sitting in their own base on the far side of you, well outside the SAM ring.
They exist so there is somewhere to practise a ground attack run without being shot at on the way in.
The HUD draws them **dashed**, which is the whole point of the visual: shape tells you what it is,
and the dash tells you it cannot hurt you.

`range: 0` already meant "no weapon", so radar and the new structures share one early exit in the
site update rather than growing a second special case. `passive` is the separate flag, and the radar
is deliberately *not* passive — it has no gun, but it is what gives every other site its full reach,
so it is a threat in a way a hangar is not.

The fuel depot is the softest target and the biggest blast: 55 hp, dead in about a third of a second
of held trigger, and it goes up in four stages over 0.85 s rather than all at once, because a single
pop reads as a crate rather than as fuel.

That blast ran into a real limit. The volumetric march costs up to 22 steps × 3 shadow steps of
fractal noise **per covered pixel**, so the puff radius is a fill-rate budget, not an art choice — a
depot-sized fireball close to the camera could cover most of the screen. The radius is capped at 24,
and a blast past the cap falls back to the full sprite count to fill out what the volume no longer
covers. Sprites cost nothing per pixel by comparison, and they already scale with the blast, so the
depot still reads as much larger than a plane.

**Checked headlessly**: the chime fires in each of the four miss cases and in none of the three
false-positive cases; both respawn paths are gated; no passive kind can reach the firing code; and
the shipped file really contains each piece rather than a plan to add it. What the checks cannot
tell you is whether the chime sounds like relief or like another alarm, which is the only question
that matters about it.

### The water was fighting the terrain, and the fix is a reversed depth buffer

The water is one plane at y=0, and `BASE_OFFSET = -40` pushes the low ground to straddle it — that
is what makes the sub-zero hollows read as lakes. It also means the two surfaces are within
centimetres of each other over a lot of the map, which is exactly the case a depth buffer has to
resolve and, at these ranges, could not.

Three.js's WebGPU backend defaults to a **`depth24plus`** attachment with the standard 1/z mapping.
At `near 0.5 / far 30000` that resolves:

| Range | `depth24plus`, default | `depth32float`, reversed | Improvement |
|---|---|---|---|
| 500 m | 0.030 m | 0.000029 m | 1.0e3× |
| 2.5 km | 0.745 m | 0.000137 m | 5.5e3× |
| 5 km | 2.98 m | 0.000248 m | 1.2e4× |
| 10 km | 11.92 m | 0.000397 m | 3.0e4× |
| 20 km | 47.68 m | 0.000397 m | 1.2e5× |

With about 5 cm between water and ground, the default buffer stops being able to separate them
**past 700 m** — well inside the visible range. That is the flicker.

`reversedDepthBuffer: true` on the renderer does two things in r0.184, and it is the pair that
matters rather than either alone: it reverses the depth mapping, *and* it switches the default depth
attachment from `depth24plus` to `depth32float`. Both were verified by reading the shipped build
rather than assumed — along with `stencil` defaulting to `false`, which is what keeps it off the
`depth32float-stencil8` path that needs a device feature. Material depth functions and the camera
projection are remapped by three itself, so nothing else in the page changes.

**The alternative I rejected**: raising the near plane from 0.5 to 5. Precision scales as `z²/n`, so
that is a 10× fix — 1.19 m at 10 km, still nowhere near enough to separate a 5 cm gap. Reversed
depth is 30,000× at the same range, and it makes precision independent of the near plane, so
`near 0.5` can stay tight for cockpit view instead of being traded away.

Two things to know if this gets copied into the game: the WebGL2 fallback path needs
`EXT_clip_control` and three drops back to the default buffer with a warning if it is missing, so
the stats panel reports **what we actually got** rather than what was asked for; and anything that
reads `viewportDepthTexture` and compares depths by hand would need its comparison reversed. This
page has no such read — `volumetric-smoke.html` does, which is one more reason the explosion puffs
here use an analytic ground plane instead.

### Choosing what you are fighting

What is in the sky is a **roster**, not a fixed lineup: a stepper per opponent class in the panel,
plus four presets — `Solo`, `Training`, `Mixed`, `Combat`.

The axis that turned out to matter is not the airframe but **`armed`**. An unarmed opponent is a
flying target you can practise gunnery and pursuit against; an armed one is a fight you have to
survive. Being able to have the first without the second is the whole feature — you should be able
to get good at flying before anything shoots back.

An unarmed aircraft never fires, never locks, and is never chosen as a target by any other AI. That
last rule is the one that makes training work: without it your allies would clean up the target
drones while you were still lining up. Practice targets are yours.

| Class | Airframe | Side | Armed | Notes |
|---|---|---|---|---|
| Ally | plane | friendly | yes | |
| Bandit | plane | hostile | yes | |
| Hunter drone | drone | hostile | yes | |
| Raptor | bird | hostile | yes | no weapons of its own; it just menaces |
| **Trainer** | plane | hostile | **no** | slower and lower than a bandit so you can catch it, and it still breaks from a missile — a target that jinks is the point |
| **Target drone** | drone | hostile | **no** | barely moves. `dummy`, so it does not evade either. Crossing one at 120 m/s is hard enough on its own |

Unarmed craft are painted high-vis orange, like a real target drone, and drawn **dashed** on the
HUD — the same rule the undefended ground structures already use, so dashed consistently means
"cannot hurt you". The HUD counts armed and unarmed separately, because "3 left" means two very
different things depending on whether they are shooting back.

`Solo` and `Training` also switch the ground sites off. A preset that leaves a SAM battery running
is not a training mode.

Two things fell out of building it:

- **Several small circuits cannot share a centre.** Circuits were centred on the player, which is
  right for planes on a 2.6 km ring — that is what puts everyone in the same fight. Eight target
  drones on a 90 m ring would have flown through each other. Any circuit under 600 m is now centred
  on the unit's own spawn point instead; measured worst-case separation for a maxed-out eight is
  539 m against a 180 m diameter.
- **Respawn distance has to scale with the circuit.** Dead AI reappeared within ±3 km of home, which
  for a bandit is the same fight and for a practice target is gone. It scales with the circuit radius
  now.

**Checked headlessly**: `Training` contains nothing armed, every class is reachable from some preset,
no preset silently omits a key (which would leave a stale count behind), unarmed craft cannot shoot
or lock and are never picked as a foe, and the eight-drone spawn geometry does not overlap.

### A kill is three events, not one

A downed aircraft used to be a single explosion and a hidden mesh. It is now a fireball where it was
hit, a burning fall, and a second, bigger detonation when it arrives.

The middle part is the only one that needs its own integrator, and it is a deliberately crude one:
ballistic gravity and linear drag, no lift, no control, plus a tumble of up to 3.6 rad/s biased
toward roll. There is no wing left worth modelling. It trails fire and heavy black smoke, pops
secondaries every half second or so on the way down, and detonates at three times the air-burst
radius when it lands — that last blast is what is left of the fuel arriving all at once.

Measured fall times: 4.9 s from 90 m, 7.6 s from 220 m, **17.6 s from 1100 m** (about a kilometre
downrange, arriving at 118 m/s), 27.6 s from 2400 m. Four things fell out of building it:

- **Finding the bug that was already there.** `poseMesh` set `g.visible` unconditionally every
  frame, which quietly undid the mesh hide in `killFlyer`. Downed aircraft were not vanishing — they
  were hanging in the air, frozen, until they respawned.
- **Fire and smoke needed separate clocks, for pool arithmetic rather than taste.** Sprites live in
  fixed pools of 72 and 96. Fire lasts 0.32 s, so a puff every 0.03 s holds about 11 alive. Smoke
  lasts nearly 3 s, so on that same clock it would have held **97** alive — one wreck would have
  consumed the entire smoke pool and starved every other effect on screen. At a puff every 0.1 s it
  holds 28, and two wrecks still fit.
- **The safety timer was nearly a bug of its own.** It started at 22 s, which is under the 27.6 s a
  2400 m kill takes, so a high kill would have detonated in mid air for no visible reason. It is 45 s
  now — a backstop, not a lifetime, since a ballistic fall always lands — and if it ever does fire it
  snaps the wreck to the ground first so the blast is not left hanging.
- **The camera cannot ride the tumble.** A chase cam bolted to a frame spinning at 3.6 rad/s is
  unwatchable, and the cockpit view is inside a burning aircraft. A downed player gets a stabilised
  chase instead: heading frozen at the moment of the kill, world up.

Two smaller consequences: respawn now waits for the wreck to land, on both of the paths that respawn
an AI, and a kill that happens *at* the ground — which is what a crash is — skips the fall entirely
and just detonates.

The evade chime also went up from 0.085 to 0.22, against the missile beep's 0.06. It has to cut
through an engine, wind and a fireball, and it is the one sound in the demo that is good news.

### Why the height field is a sum of plane waves and not a sum of `sin(x)·cos(z)`

The first version was four octaves of `sin(x·a)·cos(z·b)`, and in flight it came out as **parallel
furrows** running one way across the entire map, with moiré where they went sub-pixel. Two reasons,
compounding:

1. It is **separable**, so every bump sits on a rectangle square with the world axes.
2. Worse, and the one that actually did the damage: `sin(A)·cos(B) = ½[sin(A+B) + sin(A−B)]`. Every
   octave used `b/a` near 1, which makes A and B nearly equal, so each term collapsed to **one
   diagonal plane wave plus a long beat**. Four octaves, four near-parallel corrugations.

Replaced with 16 plane waves whose directions are spread by the golden angle and whose frequencies
are geometric at a 1.28 ratio, then domain-warped so the wavefronts meander rather than run straight.
16 and 1.28 came from a sweep: a 36-bin **high-passed** direction test drops from 5.2× to 2.5×
anisotropy, and irregularity of ridge spacing rises from 0.55 to 0.80 (coefficient of variation of
the gaps between local maxima along four transects). Fewer waves leave too few in any one size band,
so each band reads as a couple of parallel ripples again; past 16 nothing improves.

Two notes on measuring this. The first metric tried was autocorrelation, which scored both fields at
0.93 and proved nothing — it was measuring how *smooth* the ground is, not how repetitive. The second
measured plain slope by direction and scored both at 2.4×, because the 7 km landform terms dominate
slope and hide the fine corrugation completely. Only the second difference (a high-pass) at the scale
the screenshot actually showed separates them. The warp is checked separately: the Jacobian
determinant of the displacement stays above 0.43 everywhere sampled, so the field distorts without
folding back on itself.

The residual 2.5× is inherent to a small sum of plane waves — a given size band only ever holds three
or four of them. Getting to true isotropy means hash-based value noise, which is what
`terrain-field.js` does in the workspace proper and what the shipped version would use.

### Combat

Guns, missiles, flares, target markers, a radar and AI that hunts you. The reference project has a
cannon, AIM-9s and MJU-7 flares; this has the same shape, plus the thing that project cannot have —
**three airframe classes in one fight**. A plane cannot hover to hunt the drone, and the bird turns
inside everything but catches nothing.

- **Gun.** 22 rounds a second at 940 m/s, 7 damage. Bullets are swept against every craft rather
  than point-tested, which matters: at 60 fps a round moves 15.7 m per step against a 6.5 m target,
  so a point test catches only 36% of the hits that actually happen. The HUD draws a gun funnel —
  three dots showing where the rounds will be at 0.4, 0.8 and 1.2 seconds — so you can lead by eye.
- **Missiles.** Proportional navigation: turn at a rate proportional to how fast the line of sight
  to the target is rotating, which flies a collision course instead of chasing a tail. Burns for
  2.4 s to about 460 m/s, then coasts. Lock needs the target inside an 11.5° half-cone within
  5.2 km, held for 1.1 s.
- **Flares.** Eject three at a time. A flare inside the seeker's 43° cone and 520 m can steal the
  lock. The AI uses them too, and breaks perpendicular to the incoming missile while it does.
- **Damage.** 110 hp for a plane, 45 for a drone, 32 for a bird — about 0.7 s of trigger time on a
  plane, a quarter of a second on a bird. A direct missile kills anything outright. Damaged aircraft
  trail smoke, which is the only health cue you get on someone else's plane besides the HUD bar.
- **HUD.** Target boxes that scale with apparent size, name and range, a health bar once hurt, a
  lock progress ring, a diamond at full lock, edge arrows for off-screen contacts, weapon state, a
  6 km heading-up radar with altitude ticks, and a MISSILE — BREAK warning when something is
  tracking you.
- **Afterburner.** Shift on the plane, where there is no variable geometry to spend it on. 1.85x
  thrust above 92% throttle.

Verified headlessly in the scratchpad: motor burnout speed, intercepts against a straight and a 5 g
turning target, a flare stealing the lock, the swept-versus-point hit test, the lock cone and range
boundaries, and time-to-kill per class.

**Not done.** No audio at all, which is the largest single gap against the reference project. No
gun heat or reload, no missile seeker gimbal limits, no damage model beyond a single hit-point pool,
and the AI does not fight each other — only you.

### Why the height field is band-limited by distance

Fixing the furrows immediately caused a second, finer artifact: a dense stipple over the whole
distance, with fingerprint whorls in it. That one **was** aliasing, and it was caused by the fix.

A clipmap samples the height field on a lattice that doubles in size every ring — 10.7 m cells at
the centre, 170 m at 8 km. A wave shorter than two of those samples cannot be represented at all; it
folds down into a low frequency and appears as moiré. The old four-octave field bottomed out at a
812 m wavelength, which ring 4 just barely carried at 4.8 samples. Sixteen waves reaching down to
243 m gave ring 4 **1.4 samples per wavelength**, well under Nyquist.

So every wave is now faded out once the local sample spacing approaches it: full weight at 8 samples
per wavelength, gone by 4. Nyquist is 2, but 2 is where a signal becomes *representable*, not where
it looks right — the lattice is roughly 10 px across on screen at any distance, by design, so
anything varying over fewer than about 4 cells reads as stipple.

The weight is a function of **distance, not ring index**, and that detail matters: neighbouring
rings overlap along a band, and if they disagreed about the height there the seam would crack open.
Distance is the same number for both, so they agree by construction. Clipmap ring *k* reaches `S_k`
with cells of `S_k/48`, so the spacing at distance *d* is just `d/48`, clamped to the range the rings
actually provide.

| Ring | Cell | Worst samples/wavelength, before | after |
|---|---|---|---|
| 0 | 10.7 m | 22.8 | 22.8 |
| 2 | 42.7 m | 5.7 | 5.7 |
| 3 | 85.3 m | 2.8 | 4.7 |
| 4 | 170.7 m | **1.4** | 4.9 |

Physics is untouched: `heightAt(x, z)` defaults to full detail and only the picture is band-limited,
so the aircraft always flies over the real surface. Near the camera the weights are all 1, so what
you fly over and what you see are the same thing anyway.

**A second measurement trap here, after the two in the section above.** The obvious way to score
this is the fraction of height *variance* sitting below Nyquist, which came out at 0.02% and made
the problem look imaginary. Variance is dominated by the 9 km landform waves. What a shaded surface
actually shows is **slope**, and by that measure ring 4 had 22.5% of its slope in content it could
not sample, ring 3 had 8.3%. Same field, same rings, two statistics three orders of magnitude apart,
and only one of them is about what you can see.

**What was verified, and how.** The model block was extracted into the scratchpad and run headlessly:
21 checks covering plane trim and hands-off altitude hold, level-flight top speed, stall onset and
recovery, energy loss in a sustained turn, drone hover at the analytic hover throttle, drone
self-levelling, bird sustained flapping flight and stamina budget, folded-wing dives, terrain
finiteness, and three minutes of AI flight per class. That run found five real bugs, all of which
would have looked like nothing in particular on screen:

1. Trim sought **zero** AoA, which is zero lift, so an untouched aircraft sank 780 m in 30 s.
2. Trim then sought the AoA for 1 g **at the current speed**, which has no speed reference at all, so
   a dive was self-sustaining and rode into the ground. It now blends in trim for a reference speed.
3. Flap thrust pointed 0.72 upward, so the bird levitated its own flight path into a steepening
   climb until it stalled. A flap is thrust; the wing is what lifts.
4. The AI chased a target swept along a curve at `radius·rate` m/s — faster than any of the three
   could fly. All three saturated their controls and flew into the ground. It is a fixed circuit with
   a capture radius now.
5. The AI banked **away** from its target: heading is `atan2(-fwd.x, -fwd.z)`, which increases to the
   left, while positive bank rolls right. The heading error parked at 180°, flipping across the wrap,
   and the aircraft flew off the map with its wings rocking.

What no test covers is how it looks or how it feels in the hand, which is the whole question the page
was built to answer. The flight model's tuning numbers are still physically reasoned rather than
played, and every sound is judged by its waveform rather than by ear.

### Drones, and missiles you can beat

Three releasable mini drones in `flight-drones.js`, on a two-trigger weapon selector: `Space` fires
the offensive selection (gun, missile, kamikaze) and `Left Alt` cycles it; `C` deploys the defensive
one (flare, decoy, interceptor) and `Right Alt` cycles that. The bird's flap moved to `Q`. That
restructuring turned up a pre-existing defect — `fireGun` decremented the cooldown itself while the
per-flyer loop decremented it again, so a held trigger ran at 44 rounds per second against a table
that says 22. The
decoy is the neat one: it dispenses flares into the same pool the seeker already searches, so the
missile code needs no knowledge that drones exist. The kamikaze is an unpowered glider that gains
speed the whole way down and does damage in proportion to what it arrives carrying, so releasing
early and high is the entire skill. The interceptor holds station off your wing until something is
tracking you. Shot-down armed aircraft now drop a sinking ammunition canister where they died.

The interceptor turned up two bugs in shared maths, neither visible on screen. `steerToward` was
lerp-and-normalise, which is not a rotation — it delivered 0.068 rad against 0.1 commanded on a 90°
turn, and its antiparallel fallback axis was degenerate, so a 180° reversal did nothing at all. And
proportional navigation is blind dead astern: a target directly behind produces no line-of-sight
rotation, so the interceptor flew away from what it was launched at. Pointing it at an exact
intercept first needed a proper quadratic solve, because `leadPoint`'s iteration converges on the
8.19 s stern chase rather than the 2.85 s head-on when the chaser is slower than its quarry.

Missiles were undodgeable, and the measurement said so plainly: under a flat g limit a full break
turn moved the miss distance from 5 m to 6 m. Manoeuvre now scales with the square of speed and
turning costs induced drag, which closes the loop that makes evasion a skill — turning costs speed
and speed is what buys the turn. Against a 110 hp plane, a break at 800 m still dies, at 2000 m costs
70 damage, at 3600 m costs 25; breaking late is fatal at every range. The first cut of this also let
you escape by flying level, because the guidance was burning its budget fighting gravity; it
compensates for gravity now.

**Still missing**, as of the drone pass: the AI ignores terrain for cover and will fly through a hill
to reach a waypoint; there is no gun heat or seeker gimbal limit; drones cannot be shot down; only
the player carries them; and the volumetric puffs draw over terrain that should occlude them, which
is the documented cost of dropping the depth read.
