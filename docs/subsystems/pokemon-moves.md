# Pokémon moves

Procedural move effects cast between two stadium creatures, in WebGPU/TSL. `demos/pokemon-moves.html`
is the harness; `moves/` holds the effects. Five effects shipped 2026-08-16; eleven more, the shared
parts kit and the hold/status contract shipped 2026-08-17. The registry now carries **128 moves across
16 effects**.

| File | What it is |
|---|---|
| `moves/move-core.js` | The part of a move that is not a picture: the ground line, the phase machine, RNG, easings, a rate emitter. Pure JS. |
| `moves/move-parts.js` | The shared kit: ring and arc samplers, a path walker, the billboarded sprite particle system, crystal and rock geometry, a debris pool, a flash sphere, a ground decal. Deps-injected, no top-level three import. |
| `moves/move-registry.js` | The table of moves: name, type, which effect draws it, which palette, its pace, and whether it damages or holds. Pure data plus a validator. |
| `moves/fx-bolt.js` | Thunderbolt, Dark Pulse, Dazzling Gleam. |
| `moves/fx-stream.js` | Flamethrower, Water Gun, Dragon Breath, Ice Beam. |
| `moves/fx-crystals.js` | Ice Shard, Stone Edge, Psyshock. |
| `moves/fx-fissure.js` | Fissure, Earthquake, Night Daze. |
| `moves/fx-aurora.js` | Aurora Veil, Cosmic Power, Mist (self-buffs). |
| `moves/fx-cloud.js` | Drifting particle clouds: Icy Wind, the powders, Smokescreen, Heat Wave, Poison Gas. |
| `moves/fx-orb.js` | Travelling projectiles: Shadow Ball, Energy Ball, Sludge Bomb, Focus Blast, Will-O-Wisp. |
| `moves/fx-blade.js` | Swept arcs: Slash, Night Slash, Psycho Cut, Air Slash, X-Scissor. |
| `moves/fx-shock.js` | Expanding ground rings: Explosion, Magnitude, Boomburst, Surf, Discharge. |
| `moves/fx-ring.js` | Rings of erupting solids: Rock Tomb, Toxic Spikes, Sticky Web, Iron Defense, Barrier. |
| `moves/fx-vortex.js` | Standing funnels: Fire Spin, Whirlpool, Sand Tomb, Twister, Hurricane. |
| `moves/fx-skyfall.js` | Bodies falling from above: Rock Slide, Icicle Crash, Draco Meteor, Diamond Storm. |
| `moves/fx-dome.js` | Sphere-cap shields: Protect, Light Screen, Reflect, Safeguard. |
| `moves/fx-tether.js` | Links pinned at both ends: Thunder Wave, the drains, Dream Eater, Lock-On. |
| `moves/fx-field.js` | Arena-wide overlays: Trick Room, Gravity, the weather, the four Terrains. |
| `moves/fx-aura.js` | Body-scale self flourishes: Swords Dance, Calm Mind, Dragon Dance, Charge. |
| `demos/pokemon-moves.html` | Two walkers face off, a move menu, HP bars, hit flash, auto-battle. |
| `test-move-core.mjs`, `test-move-parts.mjs`, `test-move-registry.mjs`, `test-fx-*.mjs` | Node tests, one per module. |
| `test-moves-integration.mjs` | Casts every registry row through the real module and walks it to DONE. |

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

The eleven later effects came from a different exercise: ten agents in pairs read the five originals as
kits of parts and proposed recompositions, and where both members of a pair independently reached the
same fork, that fork became a module. `docs/superpowers/reviews/2026-08-16-move-fx-recomposition.md`
records what converged and what did not.

## The contract

`move-core.js` exports `makeLine({ from, to, terrainHeight, step })` — a line from attacker to target,
sampled evenly with the terrain height baked in, returning `{ origin, target, dir, side, length,
samples, pointAt(u) }` — and `createPhaseMachine({ travelSpeed | travelTime, impactTime, fadeTime,
hold, maxHold, onSpawn, onTravel, onImpact, onFade, onDestroy })`:

    IDLE → TRAVEL → IMPACT → FADE → DONE

`front` advances at `travelSpeed` m/s (eased off standstill), `u = front / length`, crossing `u = 1`
fires `onImpact` once. `onFade(dt, t)` runs with `t` in 0..1 across IMPACT and 1..2 across FADE, so a
hold reads as `t < 1`. `travelSpeed`/`travelTime` are read live, which is how the harness gives each
move its own pace without every effect knowing about it.

Two flags cover moves that are not a single bounded strike. `hold: true` parks the machine in IMPACT
until `machine.release()` is called, which is what a hazard, a screen or weather needs; `maxHold`
seconds is a ceiling the machine enforces itself, so a caller that forgets to release cannot leak a
live effect into the scene. In the registry, `hold` and `maxHold` mark the move and the harness sets
them after `cast`, and `status: true` marks a move that plays its effect without touching the health
bar. The harness's Release held button lets go of everything currently parked.

A move row may also carry `options`, an arbitrary bag forwarded straight into `cast()`. It is how two
moves on the same effect and the same palette can still differ structurally — X-Scissor is Slash with
`options: { slashes: 2 }`. The contract fields always win over it.

Every effect module has the same shape:

```js
import { createPhaseMachine, ... } from './move-core.js';
import { buildRing, createSpriteParticles, ... } from './move-parts.js';   // the only two top-level imports
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
changing the light count recompiles every material. `acquire()` returns `null` when the pool is dry and
every module must survive that; `test-moves-integration.mjs` casts all sixteen effects at once to prove
it.

Everything is deterministic from `seed` (mulberry32) and allocation-free per frame.

## The parts kit

`move-parts.js` exists because the first five modules kept every reusable helper private inside a
closure, so each new effect would have copied the same placement and particle code. It is additive: the
original five still carry their own copies and were not refactored.

| Part | What it gives you |
|---|---|
| `buildRing` / `buildArc` / `harmonic` | Terrain-sampled circles, closed or open, with the integer-harmonic trick that keeps a closed loop seamless. |
| `walkPath` / `radialWalks` | A curved random-walk stepper and a radial spray of them, from fissure's crack generator. |
| `createSpriteParticles` | The billboarded particle system. **Use this, not an `InstancedMesh`** — see the traps below. |
| `makeCrystalGeometry` / `makeRockGeometry` | Faceted prisms and jagged slabs, now parameterised rather than hard-coded. |
| `createDebrisPool` | Instanced chips with gravity, bounce and spin. `setRnd(fn)` re-points it at the current cast's generator, which a pooled kit must call or its second cast draws from wherever the first one left off. |
| `makeFlashSphere` / `popFlash` | The pop-and-fade impact flash. |
| `makeGroundDecal` | A mottled scorch or wet disc. |

Two limits worth knowing before reaching for it. `createDebrisPool` pins its bounce floor just below
each chip's spawn height, which suits debris thrown up out of the ground and not bodies falling onto it
— `fx-field.js` needed its own hail pool for exactly that reason. And `createSpriteParticles.emit()`
has no seed argument, so per-instance variation comes from a golden-ratio sequence over the emit index
rather than from the cast's RNG.

## Traps this subsystem has already hit

- Setting `positionNode` on an `InstancedMesh` material **discards `instanceMatrix`** under WebGPU:
  `NodeMaterial.setupPosition` assigns `positionLocal` after the instancing node runs. Anything
  vertex-shaded per particle must be an `InstancedBufferGeometry` under `SpriteNodeMaterial`.
- Decomposing a zero-scale `Matrix4` — the standard "hide this instance" trick used all over these
  modules — reports a scale of `(1,1,1)`, not `(0,0,0)`, because three cannot extract scale from a
  singular matrix. A test that checks for a hidden instance must read the raw matrix elements.
- Any CPU mirror of vertex-shader maths is yours to keep in sync. `fx-vortex.js` exports its radius and
  height functions and has its test re-derive them independently, which is the best pattern here.
- Grep the shipped three build before designing around a TSL node name. `fx-dome.js` did this for
  `normalWorld`/`cameraPosition` before building its fresnel term.

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
does not stretch as it reaches; FADE mirrors the clip from the mouth end. Impact: a noise-displaced
burst sphere, a ring of puffs, and a scorch/wet disc. Water takes no light.

**Crystals** (`fx-crystals.js`, palettes ice/stone/psychic). Three `InstancedMesh` variants of a
non-indexed faceted prism. Spikes are placed once at cast: a band that opens toward the target, height
rising along the line, the last 22% clustered at the impact point. Each erupts on `Easing.outBack` as
`u` passes it, stands for `holdTime`, then retracts on `Easing.inCubic`. Ice is
`MeshPhysicalNodeMaterial` with transmission, dispersion and iridescence. Only instance matrices
animate — no custom shader.

**Fissure** (`fx-fissure.js`, palettes magma/shadow/earth). `line.samples` become the main crack, with
lightning-like branches walked in XZ and re-sampled on the terrain. The ribbon puts every vertex on the
centreline and widens in `positionNode`, so width is a uniform. TSL blackbody ramp with travelling
pulses and a white-hot band at the front; an underglow pass 3.4× wider; instanced basalt lips; instanced
ember quads. The impact burst is generated at cast time in the same geometry with `aDist` past the
line's end, and tears open as `uGrown` keeps advancing through IMPACT — zero extra draw calls.

**Aurora** (`fx-aurora.js`, palettes aurora/spectrum/ice). Self-buff: the line's origin is the centre of
a ring on the terrain. One ring grid drawn twice (front, and a de-phased shorter back sheet); every
vertex sits at the hem and lift, billow and unfurl happen in `positionNode`. `colorNode` brightness
reuses the same `foldPhase` node as the sway, so the glow rides the folds. Every wave frequency is an
integer harmonic of the ring angle so the closed ring has no seam.

**Cloud** (`fx-cloud.js`, palettes frost/smoke/cinder/spore/dust). Stream with the beam removed: the
particle layer alone, and the only module that writes no TSL at all. Three emission shapes — `spray` (a
widening cone that slows as it arrives), `puff` (a burst that blooms at the target) and `drift` (a
settling field that reaches a stable population rather than thickening forever, so it survives a hold).
Only cinder takes a light; only dust draws a decal.

**Orb** (`fx-orb.js`, nine palettes). A noise-displaced additive shell with an optional dimmer halo
behind it, travelling along the line at chest height with an optional parabolic arc, trailing sprites,
and bursting into stream's dome plus a decal. The orb's world position is a plain `Object3D` transform
rather than shader maths, so there is no second copy of the flight curve to drift. Per-palette
`chargeIn` gives Focus Blast and Zap Cannon a wind-up without hard-coding the ease.

**Blade** (`fx-blade.js`, palettes steel/shadow/psychic/wind/poison/water). Bolt's ribbon with the
lightning taken out: the axis term becomes a point on a circle through the target, swept by `uProgress`,
and the kink, restrike and flicker are gone. One to three strokes per cast, fanned and staggered, so
X-Scissor crosses and Fury Cutter is a single stroke. Because there is no noise, its CPU mirror of the
shape function is exact rather than approximate.

**Shock** (`fx-shock.js`, palettes blast/quake/sonic/wave/electric/petal). One annulus whose radius is a
uniform, so the wave expands without the ring's width expanding with it. Sonic draws the same geometry
two or three times at constant radius offsets rather than building several rings. Quake adds radial
ground cracks revealed by the same uniform. A column's terrain height is sampled once at cast, at the
ring's final radius, because TSL cannot call the injected `terrainHeight` per vertex.

**Ring** (`fx-ring.js`, palettes stone/toxic/web/steel/glass). Crystals' spike records and eruption
timing with the placement swapped for a circle and the trigger keyed to angle. Every palette's shape is
an option set into `makeCrystalGeometry` rather than new geometry code. `centre` picks the target (for
hazards) or the caster (for buffs). Web adds instanced strands between adjacent pegs, hidden until both
have broken the surface.

**Vortex** (`fx-vortex.js`, palettes flame/water/sand/leaf/gale). Stream's swept surface wrapped into a
funnel on a vertical axis at the target. Because the axis is always vertical the Gram-Schmidt frame is
unnecessary — the outward normal is just `vec3(cos a, 0, sin a)` — and rotation is faked by shifting the
angle fed into the noise, so no object actually spins. Exports `funnelRadiusAt`/`funnelHeightAt` as the
CPU mirror, with the test re-deriving the formula independently.

**Skyfall** (`fx-skyfall.js`, palettes stone/ice/meteor/gem). Crystals inverted: bodies launch from a
drop height above their own landing point (sampled per body, so a slope still works) and fall under
`sqrt(2h/g)` constant acceleration. The phase front schedules **launches, not landings** — getting that
backwards makes the barrage arrive in the wrong order. Only the two largest landings take a light, and
`onImpact` fires on the largest body rather than the first.

**Dome** (`fx-dome.js`, palettes screen/reflect/safeguard/protect). Aurora's curtain closed overhead as
a true sphere cap cut by the ground plane, so the equator radius and apex height determine the sphere
analytically. The poles are the usual hazard: every column keeps its own apex vertex, and a `poleFade`
term forces the per-column sway amplitude to exactly zero there so they converge. Opacity is fresnel
weighted, strongest at grazing angles, which keeps the shell readable from inside.

**Tether** (`fx-tether.js`, palettes paralysis/drain/spectral/lock). Bolt with both endpoints pinned and
no travel clip: `uFade` becomes the attach and detach envelope. Jitter and restrike are palette-driven
so the drains can be smooth and slack while paralysis crackles. Motes stream along the link, toward the
caster for a drain and outward for a bind, on a closed-form parabola chosen to meet the sag curve at
three points.

**Field** (`fx-field.js`, ten palettes). A full-arena ground sheet with a boundary ring and an optional
wall, driven by one envelope that pins at 1 for the whole hold. The sheet uses normal blending with
opacity scaled by `dot(normalWorld, viewDir)` so it fades out rather than flaring when the camera looks
along it. The four Terrains are one pattern function parameterised four ways. It is centred on the
world origin because the harness's arena happens to sit there; a real host would pass an arena centre.

**Aura** (`fx-aura.js`, palettes might/mind/malice/draconic/growth/charge). Aurora collapsed onto the
body: radius and height derive from `sourceY`, one shader serves all six looks through baked constants
(angular gaps for blades, height gaps for rings, a twist for the helix, a rim band for malice's
inverted glow), and charge adds short vertical arcs whose kink density is scaled per metre so a short
segment does not turn to noise.

## The harness

`demos/pokemon-moves.html` loads two species through the same `stadium-glb` → `stadium-rig-map` →
`stadium-walker` path as `demos/stadium-walker.html`, stands them at x = ±1.5 facing each other with
`walk: false`, and casts from the attacker's face to the target's body. Each effect module is imported
independently and a failure disables that effect's buttons rather than the page. A hit is a white
emissive flash, a camera bump, and 12 × power off a 100-point bar; `status` moves skip all of it. Held
moves are taken down by casting the same move again or by the Release held button, and auto-battle
skips them so the arena does not silt up.

## Adding a move

A new *look* on an existing effect is a row in `MOVES` and, if needed, a palette in the effect's
`PALETTES` plus its name in `FX_PALETTES`. A new *effect* is a new `moves/fx-<name>.js` following the
contract, a `test-fx-<name>.mjs`, a key in `FX_PALETTES`, a row in `FX_MODULES` in the harness, a row in
`test-moves-integration.mjs`'s `FACTORIES`, and rows here and in `code-map.html`. Run
`node test-move-registry.mjs` for the table and `node test-moves-integration.mjs` to prove the table and
the modules actually agree — the registry's palette list is hand-written, so only the integration test
catches a row naming a palette the module does not ship.

## Open threads

- **Nothing built on 2026-08-17 has been seen rendered.** The five original effects have; the eleven new
  ones, the parts kit and every number in them have not. Node constructs the node graphs and walks the
  phases, but WGSL generation and every width, rate and intensity are unverified until the page is
  opened.
- **Nothing follows a moving creature.** `cast()` never receives either creature's transform and the
  effect group is parented to the scene, so a held tether, a worn aura and a self-buff ring all anchor
  where the caster stood at cast time. This is the single largest contract gap and it affects `aura`,
  `dome`, `ring` and `tether` most.
- **Area moves still hit one target.** `shock`, `field` and `skyfall` read as area effects but the
  harness resolves exactly one attacker and one target, so the visual reach means nothing mechanically.
- **Field effects change nothing.** Weather, terrain and the rooms are pictures; there is no notion of a
  field state that a move could read.
- **No soft-particle depth fade**: there is no depth prepass in the harness.
- Two-legged attackers cast from body height, which is a little low for a mouth; a per-species mouth
  anchor would come from the rig map's head bone.
