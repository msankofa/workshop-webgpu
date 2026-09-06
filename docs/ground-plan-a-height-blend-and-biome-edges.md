# Ground plan A: full material maps, height blending, soft biome edges

STATUS: planned 2026-09-06, not started. Follows `terrain-studio-ground-texture-plan.md`.

## What is wrong

- The splat samples colour and normal only. Every folder under `textures/ground/` already ships
  `roughness.jpg`, `ao.jpg` and `displacement.jpg`, unused.
- Layers cross-fade by weight. Real ground blends by height: where gravel and grass meet, the
  tall blades win over the low stones, and the seam follows the texture, not a smooth ramp.
- The biome id is nearest-sampled from the field window, so a biome edge is a hard line one
  field texel wide (the placement post spacing).

## Facts the plan builds on

- `terrain-splat-streamed.js` samples inside `If(weight > eps)` blocks with explicit gradients,
  one `sampleFor(name)` per slot. Adding maps means more taps in the same branches.
- `loadStreamedSplatTextures` loads two maps per slot; `loadStreamedSplatBiomeArray` packs two
  array textures. Both need a third and fourth.
- Roughness comes out of the colour `Fn` through a `property('float')` already, so a sampled
  roughness slots in where the constant per-layer guess is today.
- The field window's `gpuSampler('biomeIds')` returns the nearest texel and has the four
  corner loads inside it already (`i0`, `i1`, `f`).

## Slices

### A1. Roughness and occlusion maps

Pack roughness and ambient occlusion into one texture per folder at load (R = roughness, G = AO,
B = displacement) so the sampler count grows by one, not three. Do the packing on the CPU
through a canvas the way the biome array is packed, or as a build step that writes
`packed.jpg` next to the others (better: one file, no per-load work; add it to `manifest.json`).

Shader: `rough = mix(rough, sampledRough, detail)`, AO multiplies the colour and feeds
`aoNode`. Both fade with `detail` so the far ground keeps the flat average.

Files: `terrain-splat-streamed.js` (loader, array packer, three lines of shader), the CPU twin
untouched, `test-terrain-splat-streamed.mjs` (the loader names the third map).

### A2. Height-based blending

Per fragment, each slot's weight is sharpened by its height sample:

```
h_s   = displacement sample of slot s (0..1), from the packed map's B channel
w'_s  = w_s * (h_s + w_s)            // classic "height + weight" blend
top   = max over s of w'_s
w''_s = max(0, w'_s - top + depth)   // keep only what is within `depth` of the tallest
normalise
```

`depth` is a uniform (0.05 to 0.3, default 0.15). Because sampling only happens where `w_s >
eps`, the height read fits in the existing branch; the sharpening runs after the loop on the
values kept in vars. The CPU twin gets `splatWeightsHeight(weights, heights, depth)` so the
maths is testable.

Per-biome overrides need nothing extra: the array layer carries its own packed map.

Files: `terrain-splat-streamed.js` (about 30 lines), the twin and its test, one slider in the
studio rules block and the Base Game Terrain section (`material.rules.blendDepth`).

### A3. Soft biome edges

Sample the biome id at the four surrounding field posts and blend the four results instead of
picking one. The splat already computes everything per slot, so the cheap route is to blend
the *inputs*, not run the shader four times:

- Rule thresholds: read the four biomes' rule rows and bilinearly mix them (seven mixes). Ground
  height thresholds then slide smoothly across an edge.
- Layer choice cannot be mixed. Where the four biomes disagree on a slot's layer, dither
  between them with the same world-space hash the LOD dissolve uses, weighted by the bilinear
  factor. At normal play distance the dither reads as a soft edge a few metres wide.

Needs `gpuSampler` to expose a four-corner variant: `gpuSamplerCorners('biomeIds')` returning
the four ids and `f`. About 20 lines in `terrain-field-window.js`.

Files: `terrain-field-window.js`, `terrain-splat-streamed.js` (the rule mix and the dither),
`test-terrain-splat-streamed.mjs`.

## Uncertain parts

- Sampler count. Per slot the branch goes from two taps to three, and the biome array from two
  to three textures. The default WebGPU limit is 16 sampled textures per stage; the Base Game
  already requests up to 32 when the adapter allows. Count before A1: five slots × 2 + 2 array
  + 2 coverage + rain/water = about 14. After: about 20. A1 therefore depends on the raised
  limit, and needs a fallback (skip the packed map) on adapters without it.
- The dither in A3 is visible up close if the field posts are far apart. If it reads as noise,
  the alternative is running the sharpened blend twice for the two dominant biomes and mixing,
  which doubles the taps at edges only.

## Order

A1, then A2 (it needs the height channel), then A3.

## Verification

- Node: the loader's map names, the height-blend twin (partition of unity, tallest wins at
  depth 0, equal weights at depth 1), the corner sampler's ids.
- Browser: a grass-to-gravel edge shows blades over stones rather than a fade; a taiga-to-plains
  edge has no visible line.
