# Ground Texture Packs

Drop imported HD terrain textures into one folder per layer:

- `grass/`
- `dirt/`
- `sand/`
- `gravel/`

Add each imported file path to `manifest.json` using paths relative to this directory.
The loader only requests files listed in that manifest, which keeps missing optional
maps from producing browser 404 noise.

Accepted color map names include:

- `albedo.jpg`, `color.jpg`, `basecolor.jpg`, `base_color.jpg`, `diffuse.jpg`
- The same names as `.png`, `.jpeg`, or `.webp`
- Prefixed forms also work, such as `grass_albedo.jpg` or `grass-color.png`

Optional maps:

- Normal: `normal.jpg`, `normalgl.jpg`, `normal_gl.jpg`
- Roughness: `roughness.jpg`, `rough.jpg`
- Ambient occlusion: `ao.jpg`, `ambientocclusion.jpg`, `ambient_occlusion.jpg`

Legacy fallbacks still work:

- `grass.jpg`
- `dirt_color.jpg`
- `dirt_normal.jpg`

The loader uses terrain-v3 `materialMasks` when available. Older maps fall back to biome and slope classification.
Active biome material folders now include:

- `grass/`, `forest/`, `meadow/`, `taiga/`
- `dirt/`, `savanna/`, `swamp/`
- `sand/`, `beach/`, `desert/`
- `gravel/`, `rock/`, `snow/`

`catalog.json` records the ambientCG asset ID, source URL, and intended role for each installed layer.
The runtime currently uses color, normal, roughness, and ambient occlusion maps. Displacement maps are stored for future height/parallax work but are not rendered yet.

Additional texture choices live under `library/<ambientCG asset id>/` and are listed in `catalog.json`.
The Biomes panel reads that catalog and exposes those entries as texture sources such as `library/Grass004` or `library/Snow014`.