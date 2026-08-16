# Pokémon moves

Procedural move effects cast between two stadium creatures, in WebGPU/TSL. `demos/pokemon-moves.html`
is the harness; `moves/` holds the effects. Shipped 2026-08-16.

| File | What it is |
|---|---|
| `moves/move-core.js` | The part of a move that is not a picture: the ground line, the phase machine, RNG, easings, a rate emitter. Pure JS. |
| `moves/move-registry.js` | The table of moves: name, type, which effect draws it, which palette, and its pace. Pure data plus a validator. |
| `moves/fx-bolt.js` | Thunderbolt, Dark Pulse, Dazzling Gleam. |
| `moves/fx-stream.js` | Flamethrower, Water Gun, Dragon Breath, Ice Beam. |
| `moves/fx-crystals.js` | Ice Shard, Stone Edge, Psyshock. |
| `moves/fx-fissure.js` | Fissure, Earthquake, Night Daze. |
| `moves/fx-aurora.js` | Aurora Veil, Cosmic Power, Mist (self-buffs). |
| `demos/pokemon-moves.html` | Two walkers face off, a move menu, HP bars, hit flash, auto-battle. |
| `test-move-core.mjs`, `test-move-registry.mjs`, `test-fx-*.mjs` | Node tests, one per module. |

## Where it came from

Two MIT repos by the same author were the references, read in full before anything was written:

- **LinearAbiltyCastingThreeJS** (WebGL, GLSL) gave the *structure*: an `Ability` base with a phase machine
  and a front that advances along a cast line, a context of shared systems, and the trick of building
  geometry in parameter space and placing every vertex in the vertex shader. Its lightning shader is the
  ancestor of `fx-bolt.js`; its beam's `beamRadius(t)`/`beamAxis(t)` decomposition is the ancestor of
  `fx-stream.js`; its ice ability's placement curves are in `fx-crystals.js`. Nothing was copied as GLSL —
  every shader here is TSL.
- **GeometryPainterThreeJS** (WebGPU, TSL, TypeScript) gave three effects almost whole: crystals,
  fissures and aurora. They were de-typed and their sphere-surface stroke rebound to a ground line.

## The contract

`move-core.js` exports `makeLine({ from, to, terrainHeight, step })` — a line from attacker to target,
sampled evenly with the terrain height baked in, returning `{ origin, target, dir, side, length,
samples, pointAt(u) }` — and `createPhaseMachine({ travelSpeed | travelTime, impactTime, fadeTime,
onSpawn, onTravel, onImpact, onFade, onDestroy })`:

    IDLE → TRAVEL → IMPACT → FADE → DONE

`front` advances at `travelSpeed` m/s (eased off standstill), `u = front / length`, crossing `u = 1`
fires `onImpact` once. `onFade(dt, t)` runs with `t` in 0..1 across IMPACT and 1..2 across FADE, so a
hold reads as `t < 1`. `travelSpeed`/`travelTime` are read live, which is how the harness gives each
move its own pace without every effect knowing about it.

Every effect module has the same shape:

```js
import { createPhaseMachine, ... } from './move-core.js';   // the ONLY top-level import
export const PALETTES = { ... };
export function create<Name>Fx(deps, options = {}) {
  // deps = { THREE, TSL, NODES, scene, terrainHeight, lights }
  return { cast({ line, seed, palette, power, sourceY, targetY }) -> instance, dispose() };
}
// instance = { group, machine, update(dt, time) -> alive, dispose(), onImpact, onDone }
```

`THREE`, `TSL` and `NODES` (the node-material classes) are injected, so every module loads in Node and
its test can build the geometry, construct the node graphs and walk the phases without a GPU. What Node
cannot do is compile WGSL — a TSL type mismatch only shows in the browser. `lights` is a fixed pool of
six `PointLight`s already in the scene: effects `acquire()` and `release()`, never add or remove, because
changing the light count recompiles every material.

Everything is deterministic from `seed` (mulberry32) and allocation-free per frame.

## The effects

**Bolt** (`fx-bolt.js`, palettes electric/dark/fairy). One `InstancedBufferGeometry` ladder strip in
parameter space (t along, side ±1), one instance per filament (`aStrand`, cap 24). `positionNode` does
all the shaping: axis `mix(origin, target, t)` with sag, per-strand fan and twist, five octaves of
*linear* value noise (hard corners — no smoothstep), camera-facing width from `cross(tangent, toCamera)`,
and `uProgress` clipping the undrawn tip. `colorNode`/`opacityNode` do the cross-ribbon `pow(1-|v|,
sharpness)` falloff, tip glow, quantized flicker on `hash(floor(time·rate))`, and `uFade`. Drawn twice
over the same geometry — a wide additive glow pass, then the hot core. Plus muzzle and impact flash
spheres, one flickering point light at the front, and up to 200 CPU-driven instanced sparks.

**Stream** (`fx-stream.js`, palettes fire/water/dragon/ice). A `PlaneGeometry` used as a unit (t, angle)
grid; `positionNode` builds a Gram-Schmidt frame from `uStart`/`uEnd`, places the vertex on the axis
with a catenary sag `4·sag·t·(1−t)`, and pushes out by a cone radius modulated by `mx_noise_float`
scrolling downstream. The front is a clip (`smoothstep` on `uProgress`), never a scale, so the texture
does not stretch as it reaches; FADE mirrors the clip from the mouth end. Puffs are an
`InstancedBufferGeometry` of quads under `SpriteNodeMaterial` with per-instance `aPos/aLife/aSize/aSeed`
attributes — **not** an `InstancedMesh`, because setting `positionNode` on an `InstancedMesh` material
discards `instanceMatrix` under WebGPU (`NodeMaterial.setupPosition` assigns `positionLocal` after the
instancing node runs). Impact: a noise-displaced burst sphere, a ring of puffs, and a scorch/wet disc.
Water takes no light.

**Crystals** (`fx-crystals.js`, palettes ice/stone/psychic). Three `InstancedMesh` variants of a
non-indexed faceted prism (hex, jittered per facet column, tapered, off-axis apex). Spikes are placed
once at cast: a band that opens toward the target, height rising along the line, the last 22% clustered
at the impact point. Each erupts on `Easing.outBack` as `u` passes it, stands for `holdTime`, then
retracts on `Easing.inCubic`. Ice is `MeshPhysicalNodeMaterial` with transmission, dispersion and
iridescence; stone is flat-shaded `MeshStandardNodeMaterial`; psychic adds emissive. Chips pop and
bounce at each breach. Only instance matrices animate — no custom shader.

**Fissure** (`fx-fissure.js`, palettes magma/shadow/earth). `line.samples` become the main crack, with
lightning-like branches walked in XZ and re-sampled on the terrain. The ribbon puts every vertex on the
centreline and widens in `positionNode` (`aSide · width · aAcross · aJit`), so width is a uniform. TSL
blackbody ramp with travelling pulses and a white-hot band at the front; an underglow pass 3.4× wider
(skipped for earth); instanced basalt lips heaved up on `Easing.outBack`; instanced ember quads with a
radial falloff on `uv()`; up to three pooled lights. The impact burst (4–6 radial cracks at the target)
is generated at cast time in the same geometry with `aDist` past the line's end, and tears open as
`uGrown` keeps advancing through IMPACT — zero extra draw calls.

**Aurora** (`fx-aurora.js`, palettes aurora/spectrum/ice). Self-buff: the line's origin is the centre of
a ring of radius `options.radius` on the terrain. One ring grid drawn twice (front, and a de-phased
shorter back sheet); every vertex sits at the hem and lift, billow and unfurl happen in `positionNode`.
`colorNode` brightness reuses the same `foldPhase` node as the sway, so the glow rides the folds. Every
wave frequency is an integer harmonic of the ring angle so the closed ring has no seam (a test asserts
it). Hem glow strip, instanced motes twinkling on `hash(instanceIndex)`, three pooled lights.

## The harness

`demos/pokemon-moves.html` loads two species through the same `stadium-glb` → `stadium-rig-map` →
`stadium-walker` path as `demos/stadium-walker.html`, stands them at x = ±1.5 facing each other with
`walk: false` (the idle clip plays on the non-leg bones), and casts from the attacker's face
(`body.pos` pushed forward by 35% of its leg span) to the target's body. `sourceY`/`targetY` are the
body heights above ground. Each effect module is imported independently and a failure disables that
effect's buttons rather than the page. A hit is a white emissive flash on the target's materials, a
camera bump, and 12 × power off a 100-point bar. Auto-battle alternates sides every 2.4 s with a random
loaded move.

## Adding a move

A new *look* on an existing effect is a row in `MOVES` and, if needed, a palette in the effect's
`PALETTES` plus its name in `FX_PALETTES`. A new *effect* is a new `moves/fx-<name>.js` following the
contract, a `test-fx-<name>.mjs`, a key in `FX_PALETTES`, a row in `FX_MODULES` in the harness, and rows
here and in `code-map.html`. Run `node test-move-registry.mjs` — it fails on a row that names an effect
or palette that does not exist.

## Open threads

- Nothing here has been seen rendered yet. Every module's node graphs construct in Node, and
  `test-fx-bolt.mjs` actually executes the TSL function bodies inside a `stack()`, but WGSL generation
  and every number (widths, rates, light intensities) are unverified until the page is opened.
- Motes, embers and sparks are flat quads, not billboards, so they thin edge-on. `SpriteNodeMaterial`
  with instanced attributes (the stream's approach) is the fix if it shows.
- No soft-particle depth fade: there is no depth prepass in the harness.
- Two-legged attackers cast from body height, which is a little low for a mouth; a per-species mouth
  anchor would come from the rig map's head bone.
