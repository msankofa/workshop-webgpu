# Lava / volcano rendering (backlog, not implemented)

> Speculative — no volcano feature exists in this codebase or in terrain-v3 today
> (confirmed by grepping both repos for volcano/lava/magma/crater; the only hits are
> `celestial-bodies.js`'s unrelated procedural planet/skybox surface texturing). This
> doc exists so the rendering-side plan isn't lost before the generation-side work
> (tracked in terrain-v3, see below) is ready to feed it real terrain.

## Dependency

This is entirely a follow-on. It needs terrain-v3 to actually export volcano geometry
first — see item 6 ("Volcano feature stamping") in
`G:\My Drive\Scripts\html game\html-game-v2\tools\terrain-v3\terrain-v3-update-backlog.md`.
Nothing here can be built meaningfully until an authored map's GLTF mesh has a crater
(or, for a true hollow caldera, a marching-cubes volumetric mesh) to attach a material
and effects to.

## What it would reuse

Every piece of this maps onto infrastructure that already exists in this repo — this is
assembly, not new systems:

- **Lava material** — animated flow-map emissive shader: scrolling/distorting UVs
  driven by noise, an emissive color ramp (near-black cooled crust → bright
  orange/yellow at "hot" cracks). The `addEmissive` option already threaded through
  `createForestGPU` (`forest-gpu.js`), `createComputeGrass` (`grass-compute.js`), and
  `createCdlodTerrain` (`cdlod-terrain.js`) is the existing convention this should slot
  into rather than inventing a new emissive path.
- **Bloom** — `post-fx.js` already has a bloom pass; the lava emissive glow just needs
  to be bright enough to trigger it, no new post-fx code.
- **Heat shimmer** — a screen-space refraction distortion above the lava surface,
  sampling the background through a scrolling noise offset. Same trick `water.js`
  already uses for its refraction/caustic projection (`refractVec`, `uRefractedLightG` —
  see `docs/subsystems/water.md`), just applied above a lava plane instead of below a
  water plane.
- **Ember/smoke particles** — `particle-field.js`/`particles.js` are GPU-instanced
  particle systems already built for exactly this (rising embers, drifting smoke/ash
  columns with wind advection). An eruption burst is a scripted particle spike, nothing
  structurally new.
- **Eruption color grade** — `post-grade.js` already does color grading; an eruption
  event pushing a temporary grade shift (screen warming, contrast punch) is a parameter
  change, not new code.
- **Hazard gameplay** — a per-tick distance-to-lava-surface check dealing
  damage/knockback, the same shape as the creature sim's existing
  `resolveCreatureCollisions`/`collisionRadius` pattern (`docs/subsystems/creature.md`).

## What's actually new work

- The lava material shader itself (flow-map UV animation + emissive ramp) — no existing
  file does this specific look, though it's close in spirit to `water.js`'s surface
  shader.
- Wiring an authored map's volcano crater/caldera region (once terrain-v3 exports one)
  to know where to place the lava plane/pool mesh and the hazard trigger volume.
- Cellular-automata-style local lava spread, if wanted — optional, most games skip this
  and use a static lava pool per volcano instead.

## Non-goals

- No real fluid simulation (not real-time feasible; not what any shipping game does for
  lava either — see the "how games implement volcanoes" discussion this doc originated
  from).
- No dynamic terrain deformation (lava permanently reshaping the mesh at runtime) — out
  of scope unless a future design explicitly asks for it; static per-volcano lava pools
  are the default assumption here.
