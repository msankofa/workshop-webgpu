// dissolve.js -- noise-thresholded dissolve with a glowing burn edge.
//
// Drives bot spawn-in (progress 0 -> 1) and death (1 -> 0) from a single scalar, so the game
// only has to feed it a normalized timer. Geometry is discarded rather than alpha-blended:
// discard has no sort order, which matters because bot shells are instanced and self-occluding.
//
// The dissolve field mixes fractal noise with a vertical sweep so the effect reads as a
// direction (materializing upward) instead of a uniform fizzle.
import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  Fn, uniform, float, vec3, mix, smoothstep, clamp, Discard, positionLocal, mx_fractal_noise_float,
} from 'three/tsl';
import { resolveParams, uniformSeed, buildHandle } from './material-demo-api.js';

export const meta = {
  id: 'dissolve',
  name: 'Dissolve / Materialize',
  blurb: 'Fractal-noise threshold with a glowing burn edge. One scalar drives spawn-in and death.',
  targets: 'Bot shell, props, pickups',
  cost: 'low',
  base: 'MeshStandardNodeMaterial',
  notes: 'Discards fragments, so it needs no alpha sorting. Feed `progress` from a spawn or death timer.',
  // Octaves is a shader loop count, not a uniform -- changing it rebuilds the material.
  rebuildOn: ['octaves'],
  params: [
    { key: 'progress', label: 'Progress', type: 'float', value: 1.0, min: 0, max: 1, step: 0.001,
      hint: '0 = fully dissolved, 1 = fully solid.' },
    { key: 'noiseScale', label: 'Noise scale', type: 'float', value: 3.2, min: 0.2, max: 20, step: 0.1 },
    { key: 'octaves', label: 'Octaves', type: 'float', value: 3, min: 1, max: 6, step: 1,
      hint: 'Rebuilds the material when changed.' },
    { key: 'sweep', label: 'Vertical sweep', type: 'float', value: 0.45, min: 0, max: 1, step: 0.01,
      hint: 'Blends the noise field toward a bottom-to-top wipe.' },
    { key: 'heightScale', label: 'Sweep height', type: 'float', value: 0.6, min: 0.05, max: 4, step: 0.05,
      hint: 'Local-space height the sweep spans. Match to the mesh.' },
    { key: 'edgeWidth', label: 'Edge width', type: 'float', value: 0.09, min: 0.005, max: 0.4, step: 0.005 },
    { key: 'edgeIntensity', label: 'Edge glow', type: 'float', value: 4.0, min: 0, max: 20, step: 0.1,
      hint: 'Above ~1 this blooms. Tune against the post-fx bloom threshold.' },
    { key: 'edgeColor', label: 'Edge color', type: 'color', value: 0x59f2c8 },
    { key: 'baseColor', label: 'Base color', type: 'color', value: 0x8a939f },
    { key: 'roughness', label: 'Roughness', type: 'float', value: 0.55, min: 0, max: 1, step: 0.01 },
    { key: 'metalness', label: 'Metalness', type: 'float', value: 0.15, min: 0, max: 1, step: 0.01 },
  ],
};

export function create({ params: overrides } = {}) {
  const params = resolveParams(meta, overrides);
  const uniforms = {};
  for (const p of meta.params) {
    if (meta.rebuildOn.includes(p.key)) continue;   // baked into the graph, not a uniform
    uniforms[p.key] = uniform(uniformSeed(p.type, params[p.key]));
  }
  const octaves = Math.max(1, Math.round(params.octaves));

  const material = new MeshStandardNodeMaterial();
  material.side = THREE.DoubleSide;   // discard opens the shell; back faces keep it readable

  // Built once and referenced by both colorNode and emissiveNode. Both compile into the same
  // fragment stage, so the shared node instance is emitted once rather than per reference.
  const field = Fn(() => {
    const n = mx_fractal_noise_float(
      positionLocal.mul(uniforms.noiseScale), octaves, float(2.0), float(0.5), float(1.0),
    ).mul(0.5).add(0.5);
    const height = clamp(positionLocal.y.div(uniforms.heightScale).add(0.5), 0.0, 1.0);
    return mix(n, height, uniforms.sweep);
  })();

  // Discard has to be recorded inside an Fn body to attach to the graph.
  material.colorNode = Fn(() => {
    Discard(field.greaterThan(uniforms.progress));
    return vec3(uniforms.baseColor);
  })();

  const edge = smoothstep(uniforms.progress.sub(uniforms.edgeWidth), uniforms.progress, field);

  material.roughnessNode = uniforms.roughness;
  material.metalnessNode = uniforms.metalness;
  material.emissiveNode = vec3(uniforms.edgeColor).mul(edge).mul(uniforms.edgeIntensity);

  return buildHandle({ meta, material, uniforms, params });
}
