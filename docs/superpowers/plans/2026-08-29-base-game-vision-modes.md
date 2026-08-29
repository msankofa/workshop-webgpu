# Base Game visor: NVG and thermal

Status: PLAN ONLY, nothing built. Written 2026-08-29.

The ask: base-game gets a helmet visor with night vision and thermal, the way `demos/flight-sim.html`
has them. This is what the flight sim actually does, what stops base-game from copying it, and the
order to build it in.

---

## 1. How the flight sim does it

All of it lives in `vision-modes.js` (155 lines) plus about 40 lines of wiring in the demo. Four parts.

**Two uniforms are the whole switch.** `uMode` (0..3) and `uIR` (1 under either thermal palette).
`setVisionMode(name)` writes both and is the only place a mode name becomes a number. Nothing else in
the codebase branches on the mode on the CPU.

**Heat is a property of things, not of the picture.** This is the part worth copying and the part that
costs the work. The cheap thermal everyone writes is a luma remap of the lit frame, and it is wrong in
the way that matters: sunlit grass reads hot, a shadowed engine reads cold, because it is measuring
light. So instead every material carries a heat value:

- `heatTag(material, heat)` rewrites `colorNode` and `emissiveNode` *in terms of the material's own*
  `materialColor` / `materialEmissive` nodes. Under IR the diffuse goes to black, the emissive becomes
  a flat heat grey, roughness goes to 1 and metalness to 0. Lighting cannot reach the picture at all.
  Writing it in terms of the material's own nodes is why a pooled particle whose `.color` is set per
  emit still tints correctly under RGB.
- `heatMix(rgbNode, heat)` is the opt-in for a material that already owns a colour graph (the terrain,
  the sky, the water) — `heatTag` would overwrite that graph, so those are wrapped by hand.
- `tagScene(root)` sweeps everything untagged at `DEFAULT_HEAT` and **returns the list it could not
  tag**, which is the honest part: it tells you what will render as a lit RGB object in a heat frame.

**A post composite maps heat to a palette.** `createVisionComposite` builds a `PostProcessing`, takes
`pass(scene, camera)`, computes luma, and picks between RGB, NVG green, white-hot and black-hot, each
with a per-pixel time-hashed noise floor and a vignette so a still frame still crawls like a sensor.
It sets `outputColorTransform = false` and applies `renderOutput` by hand, so RGB mode is identical to
the plain render.

**The page wires it in about 40 lines.** `V` cycles; `setVision` re-runs `tagScene` (catching anything
spawned since), thins the fog to 35% under IR because a thermal sensor sees through haze that stops the
eye, shows a banner and plays a click. The render call is a two-way branch:
`if (visionMode === 'rgb') renderer.render(scene, camera); else vision.render();`

---

## 2. What stops base-game copying it

Five things. The first two are the real work; the rest are small.

### 2.1 Base-game already owns a post pipeline

`base-game.html:1084` has `const postPipeline = new RenderPipeline(renderer)` driving depth of field,
and the frame branches between `postPipeline.render()` and `renderer.render(scene, camera)` depending
on `settings.dofEnabled` (line ~4741).

`createVisionComposite` builds its *own* pipeline around its *own* `pass(scene, camera)`. Two pipelines
means two scene passes — the scene rendered twice per frame — and DoF and NVG become mutually exclusive.
(The import itself is fine: `PostProcessing extends RenderPipeline` in the r184 build, verified at
build line 83025.)

So vision cannot be bolted on as a second composite. It has to become a node inside the pipeline that
is already there.

### 2.2 The characters and the guns are classic materials, and classic materials cannot be tagged

This is the one that would make a naive port look broken rather than unfinished.

| source | what it draws | materials |
|---|---|---|
| `player-procedural-body.js` | the local player's body | 15 classic `MeshStandardMaterial` / `MeshBasicMaterial` |
| `body-part-batches.js` | every instanced remote player and NPC bot | 15 classic, one `InstancedMesh` per shared geometry |
| GLB weapons via `weapon-mount.js` | every gun, held and stowed | GLTFLoader output, classic `MeshStandardMaterial` |

`heatTag` refuses a classic material and flags `userData.irUntaggable`, and its comment ("the renderer
converts it and we cannot reach in") is correct: the conversion happens inside `NodeBuilder` via
`renderer.library.fromMaterial(material)` at shader-build time (build line 52577), and the app is never
handed the result. Verified in the shipped build, not assumed.

**So a straight port gives you a thermal view where the terrain, sky, water and trees are heat grey and
every human and every weapon renders as a normal lit RGB object.** That is precisely backwards: people
are the thing a thermal sight exists to find.

The fix is mechanical — construct the Node twins (`MeshStandardNodeMaterial`, `MeshBasicNodeMaterial`)
in those three places — but it is a change to the character rendering path, so it wants its own phase
and its own before/after look.

One genuinely uncertain bit sits inside it. `body-part-batches.js` colours bots per instance
(`setColorAt`, line 147), and three multiplies `colorNode` by `instanceColor`. `vision-modes.js` already
records this as a KNOWN LIMITATION from the flight sim's debris pools: the heat grey comes out tinted
by each instance's own colour and reads cooler than the tag asks for. On debris that is cosmetic. On
bots it means **a bot's team colour changes how hot it looks**, which defeats the mode. I do not yet
know the cheapest fix; see Phase 1 for the three candidates.

### 2.3 A pre-existing bug in the code path this extends

`RenderPipeline.outputColorTransform` defaults to `true` (build line 82831), and when true the pipeline
wraps `outputNode` in `renderOutput` itself (build line 82977). Base-game sets
`postPipeline.outputNode = renderOutput(depthOfField.node)` and never sets the flag, so **the DoF path
applies the output transform twice** — tone map and sRGB encode, then tone map and sRGB encode again.

Reading the code says DoF-on should look visibly washed out next to DoF-off. I have not put it in front
of a browser, so treat that as inferred, not measured. Either way it has to be settled before vision
modes land, because RGB mode is supposed to be identical to the plain render and it cannot be while the
pipeline is double-encoding.

### 2.4 `V` is taken

`V` toggles first/third person (`base-game.html:4085`). Keys currently bound: W A S D, Shift, Space,
arrows, B C F G L N Q R T V Z, Digit1-9. Free letters: **E H I J K M O P U X Y**.

Proposal: **`H`** for the helmet visor, cycling `rgb -> nvg -> white-hot -> black-hot -> rgb`. `N` would
read better for night vision but it is the drone recall.

### 2.5 Multiplayer, and what a "visor" means

Base-game is server-authoritative and the flight sim is single player. A vision mode is a pure client
render setting: no protocol change, no version bump, nothing to replicate. Worth saying plainly because
"a visor" sounds like a wearable item, and a wearable others can see on your head *would* be a protocol
change. That is not in this plan.

---

## 3. The plan

Five phases. Each ends somewhere the page still runs.

### Phase 0 — one pipeline, one output transform

No new files. `base-game.html` and `vision-modes.js`.

1. Add `visionNode(colorNode)` to `vision-modes.js`: takes a colour node, returns the graded `vec4`
   (palette select + noise + vignette). Refactor `createVisionComposite` to call it, so the flight sim
   keeps working through exactly the same maths and there is one copy of the palette.
2. In `base-game.html`, feed the existing `scenePass` through DoF and then through `visionNode`, and
   set `postPipeline.outputColorTransform = false` — which is also the 2.3 fix, since the outputNode
   already applies `renderOutput`.
3. The render branch becomes: plain `renderer.render` only when DoF is off **and** the mode is RGB;
   otherwise `postPipeline.render()`. So RGB with DoF off keeps today's zero-cost path.
4. Confirm RGB-with-DoF-on now matches RGB-with-DoF-off. This is the check that proves 2.3.

Risk: low. Uncertainty: whether `visionNode` composes cleanly downstream of the DoF gather rather than
upstream of it. The order I want is DoF first (a sensor's optics blur before the sensor sees), then the
palette; if that reads wrong, the alternative is palette-then-DoF and it is a one-line swap.

### Phase 1 — make the characters and weapons taggable

`player-procedural-body.js`, `body-part-batches.js`, `weapon-mount.js`.

1. Swap the classic constructors for their Node twins. Mechanical, roughly 30 material constructions.
2. Grep for anything depending on the classic class — `.isMeshStandardMaterial` tests, and the blood
   and wound decorators (`wound-mask.js`, `applyWetSurface`) that already assign nodes. Node twins
   accept everything the classic ones do; the risk is a type check, not a property.
3. GLB weapons: convert template materials once at load in `weapon-mount.js`, where the template cache
   already owns them, rather than per instance.
4. Settle the per-instance colour question. Three candidates, cheapest first:
   a. Under IR, set the instance colour buffer to white and restore on the way out. One buffer upload
      per mode change, no shader work, but it fights anything else writing that buffer that frame.
   b. Give the batch a per-instance heat channel, as `vision-modes.js` already suggests for debris.
      Correct, and it buys per-bot heat (a dead bot cooling, a hot barrel) which (a) cannot express.
   c. Accept the tint and document it. Cheapest, but it makes team colour read as temperature, which
      is the failure the mode exists to avoid.
   I would build (b) unless it turns out to need more of `body-part-batches.js` than expected, in which
   case (a) ships first and (b) follows.
5. A test asserting `tagScene(scene).untaggable` is empty for a scene containing a player body, an
   instanced remote and a held weapon.

Risk: medium, and it is the phase to look at in a browser before moving on — it touches how every
character renders in *normal* RGB play, not just under the visor.

### Phase 2 — heats for base-game's world

Assign real heats instead of letting `tagScene` default everything to 0.30. Roughly:

| thing | heat | note |
|---|---|---|
| players, NPC bots | `HEAT.skin` 0.50 | the thing the mode exists to find |
| dead bodies | cooling from skin toward `HEAT.cold` | needs the per-instance channel from Phase 1b |
| terrain splat, water, sky, clouds | `terrain` / `water` / `sky` / `cloud` | all own colour graphs, so `heatMix` |
| trees, grass | `HEAT.cold` 0.22 | vegetation reads cold, which is what makes bodies pop |
| muzzle flash, tracers, explosions | `fire` / `tracer` | already `MeshBasicNodeMaterial`, so `heatTag` works |
| blood, debris, smoke | `warm` / `smoke` | smoke owns a graph, so `heatMix`, same as the flight sim |
| rain, lightning | `water` / `fire` | flight-sim already has the pattern for both |

Then the two environment behaviours the flight sim ships: thin the fog under IR, and re-sweep
`tagScene` on every mode change so anything spawned since is caught.

Risk: low. Every number here is a guess until it is on screen, exactly like the flight sim's were.

### Phase 3 — the visor as a device

`base-game.html`, plus settings and panel.

1. `settings.visorMode` (one of the four), registered in `controlRegistry` with a select — base-game
   throws `Unsaved/unconfigured settings` at boot for anything unregistered — and persisted to disk
   through the existing autosave, never `localStorage`.
2. `H` cycles it, writing the setting so the key and the panel are one switch (the pattern the `L`
   flashlight key already follows).
3. HUD line while a mode is active, matching the existing `[L] flashlight on` line.
4. Per-mode tuning sliders: NVG gain, noise, vignette, and the thermal threshold and span. These are
   uniforms already implied by the palette maths; exposing them means `visionNode` takes uniforms
   rather than the literals it uses today.

### Phase 4 — the interactions worth getting right

These are what make it feel like a visor rather than a screen filter, and each is small on its own.

- **Scope and visor.** `scope-overlay.js` draws a DOM overlay over the canvas, so it sits *outside* the
  post pipeline and will stay full-colour while the world goes green. Either tint the overlay from the
  mode or accept it; the overlay is already mode-agnostic CSS, so tinting is a class swap.
- **Laser and NVG.** A real IR laser is invisible to the eye and blazing under NVG. `weapon-laser.js`
  already carries a `hue` and an intensity; an "IR" setting that drops it to near-nothing under RGB and
  raises it under NVG is a few lines and is the single most convincing detail in the whole feature.
- **Flashlight and thermal.** A white light does not warm anything, so the flashlight should do nothing
  under IR — which it already does for free, since `heatTag` removes lighting from the IR path. Worth a
  test so it stays true.
- **Muzzle flash.** Blooms hard under NVG. The palette's gain already does this; check it does not
  white out the frame.

---

## 4. What this plan does not cover

- A visor as a worn item other players can see. That is a protocol change and is deliberately out.
- Battery, warm-up, or a damage model for the visor.
- Per-object heat that changes over time (a hot barrel, a running engine, a cooling corpse) beyond the
  one cooling case in Phase 2 — the channel from Phase 1b is what would make the rest cheap later.
- Any claim about how the defaults look. Nothing here has been in a browser.

## 5. Files

New: none required. `test-vision-modes.mjs` already exists and grows; a base-game wiring test joins it.

Touched: `vision-modes.js`, `base-game.html`, `player-procedural-body.js`, `body-part-batches.js`,
`weapon-mount.js`, and in Phase 4 `weapon-laser.js` and `scope-overlay.js`.

Docs on the way out: `docs/subsystems/fx.md` (vision-modes gains a base-game consumer),
`docs/subsystems/base-game.md` (the visor, the key, the settings), and a row per phase in
`agent_log.csv`.
