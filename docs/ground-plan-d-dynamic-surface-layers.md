# Ground plan D: dynamic surface layers (wet, snow, mud) over the base set

STATUS: planned 2026-09-06, not started. Independent of plans A to C.

## What is wrong

A project picks one texture set, and the weather has to fake the rest. Rain darkens the ground
and pools puddles (`rain.js` through the splat's `rain` bundle), and the water module wets a
tide band, but there is no snow cover, no mud where it rained on dirt, and no way for a texture
to change with the world's state. Studios treat these as masks layered over the base material,
each with its own texture, driven by weather, season and gameplay.

## Facts the plan builds on

- The splat already has the pattern: the wet block sits behind `If(uWetness > 0)` so a dry
  world pays a compare. Snow and mud follow the same shape.
- The field window streams `moisture` per post (a biome-derived proxy) and can carry more
  fields; plan B's control field is the same mechanism.
- The rain module owns `uWetness` and its accumulation. Snow needs an equivalent owner.
- Every ground folder has a colour, normal and (after plan A) a packed map, so a dynamic layer
  is just one more folder chosen in the studio.

## Slices

### D1. Layer slots in the project

`material.layers = { wet?: folder, snow?: folder, mud?: folder }` and per-biome overrides of
the same. The studio's material panel gets three more picker rows under the slots, labelled
by what drives them. Unset means the current behaviour (wet by darkening only, no snow, no
mud).

Files: `terrain-project-v5.js`, `terrain-generator-v5.html`, tests.

### D2. Snow cover

A snow layer is a mask and a texture. The mask has three inputs multiplied together:
- **Weather.** A `uSnowCover` uniform (0..1) owned by a small `snow.js` beside `rain.js`, with
  accumulation and melt rates and a settings block, plus a snowfall particle hook later.
- **Exposure.** Flat faces collect snow, steep faces shed it: `smoothstep(rockFull, 1, N.y)`.
- **Shelter.** Under trees and roofs less falls. Plan B's control field, or the flora occlusion
  pass, can write a shelter byte per post. First version: none.

Where the mask is high, the snow texture replaces colour and normal, roughness rises, and the
height blend (plan A2) lets grass tips poke through thin cover. Behind `If(uSnowCover > 0)`.

Files: `snow.js` (new, about 80 lines), `terrain-splat-streamed.js` (a `snow` bundle like
`rain`), `base-game.html` (settings and a Weather section row), multiplayer: `uSnowCover` is
world state, so it rides the same host-owned weather message rain does.

### D3. Mud

Mud is wetness applied to dirt-like ground over time. Mask = `uWetness` accumulated with a slow
release, times the dirt and grass weights, times flatness. The mud texture replaces the dirt
texture through the height blend, with roughness dropped and the puddle field from the rain
module boosted. A ground that was rained on stays muddy for a while after the rain stops.

The accumulation lives on the rain module as `uMudMemory`, integrated per frame from
`uWetness` with a decay setting. No field is needed for the first version; a per-post memory
(so a sheltered patch stays dry) is the plan B field again.

Files: `rain.js` (the memory uniform and its step), `terrain-splat-streamed.js`,
`base-game.html`.

### D4. Wet as a texture, not a darkening

Today wetness scales albedo and roughness. With D1's wet folder, wet ground can also take a
different normal (smoother) and a darker, glossier colour from its own map, blended by the
same wetness mask. Small change once D2 exists; it reuses the bundle shape.

### D5. Gameplay writes

Expose `terrain.stampSurface(x, z, radius, layer, amount)` so explosions clear snow to dirt,
vehicles rut mud, and fire scorches. It writes the plan B per-post field. Without plan B this
slice has nowhere to write; it is listed so the field is designed with a write path.

## Uncertain parts

- Sampler count again. Three more folders is six more taps at worst. With plan A's packed map
  and the raised limit there is room; without it, the dynamic layers must share the biome
  array (they are just more layers in it, chosen by mask instead of by biome), which is the
  cleaner design anyway and probably where this should start.
- Snow and the LOD cascade. The coarse levels render the same material, so cover matches, but
  the far tint (the average colour past `fadeFar`) must mix toward the snow average or the
  horizon stays green under snow.
- Multiplayer ordering. Weather state arrives from the host; a guest joining mid-snow needs the
  accumulated value, not just the rate.

## Order

D1, D2, D3, D4, D5. D2 alone is the visible win.

## Verification

- Node: the project block, the snow module's accumulate and melt, the mud memory step.
- Browser: turn snow cover up and watch flats whiten while cliffs stay bare; rain for a while,
  stop, and see mud linger on dirt paths and fade.
