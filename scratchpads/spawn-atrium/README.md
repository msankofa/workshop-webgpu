# Eco-brutalist spawn area

A demonstration that eco-brutalist structures can be generated from the repo's own pieces, built
2026-09-03 before any Base Game change. Two precedents are combined:

- The look and growth are bot-viewer-v3's eco-brutalism: `createVisualSystem` with the
  `ecobrutal` theme (concrete form panels, tie holes, rain streaks, moss, algae) and
  `bot-flora.js` (grass, understory plants, vines). The viewer follows `structure-viewer.html`'s
  wiring line for line.
- The working method is the img2threejs pipeline in `../rq170-sentinel/`: references in `ref/`,
  an `intake-analysis.md` that keeps observation and inference apart, and a viewer with the
  references beside the render, camera presets, wireframe and a screenshot button. The
  silhouette gate is not used: it needs one object and an orthographic drawing, and these are
  five perspective photographs of five buildings.

## Files

- `eco-gen.js`: the pure generator. Seven kinds in metres, no THREE: `atrium`, `lobby`,
  `pergola`, `slotgarden`, `pavilion`, `spawn` (slot garden, lobby under a lattice, pavilion
  with pond, in a line), and `complex`: one building where slot gardens are the hallways. The
  atrium sits north, a hallway runs south into the lobby, a second hallway runs east from the
  lobby to the pergola court, and the pavilion and pond hang off the lobby's open south side.
  A slot garden takes an `axis`, a `length` and an `endWall` flag so it can be a corridor.
- `test-eco-gen.mjs`: 87 checks. Run `node scratchpads/spawn-atrium/test-eco-gen.mjs`.
- `viewer.html`: the page. Needs the repo's `serve.py` because it imports repo modules.
- `ref/`, `intake-analysis.md`, `shots/` (screenshots go here by hand; the page saves to your
  downloads folder).

## Looking

```
python serve.py
```

then open `http://127.0.0.1:8080/scratchpads/spawn-atrium/viewer.html`. The kind dropdown
picks one structure or a gallery of all six. The eye-level preset stands at that structure's
spawn point.

## Growth rules in this page

Plants and grass grow only inside planters (`clearFn` rejects everything else) and stand on the
soil top, not the ground plane. Vines hang from every standing wall's top edge and from slabs
that are wide enough to read as a canopy. Floor slabs sit below grade and are not keep-outs.

## Performance pass (2026-09-03)

Counted headlessly with `node scratchpads/spawn-atrium/count-growth.mjs <kind> [band]`, which runs
the viewer's own growth rules over the generator's output:

| | before | after |
|---|---|---|
| grass blades built for `complex` | 643k (whole 169 m bounds square) | 210k (18 m band around the building) |
| resident point lights at intensity 0 | 5 (four accents, one arena overhead) | 0 (hidden host-side) |
| post passes | scene + six-pass bloom at strength 0.08 + grade | scene + grade |
| vine strands for `complex` | 2633 | 2633 (unchanged) |

Header controls switch the grass lighting model, grass shadow receipt, shadow map size and shadow filter live; the URL parameters `shadow`, `pcf`, `grassLight` and `grassShadow` only set the starting values.

The HUD shows fps, CPU ms for the visuals, flora and render phases from `frame-profiler.js`, draw
calls, triangles and the geometry and texture counts. The geometry and texture counts should hold
still while the page idles; a rising count is a rebuild leak.

The shadow map defaults to 1024 since 2026-09-03 (the user chose it after seeing the numbers); the
but the lattice stripes are 12 cm bars and would break up at 2048 over these bounds.

## Not done

No trees, no glass in the lattice, no strip lights, no round columns, no lily pads. The plant
species are the bot viewer's understory set, not palms or tree ferns. Nothing here is wired into
the Base Game and no repo module was changed.
