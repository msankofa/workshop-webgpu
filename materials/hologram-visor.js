// hologram-visor.js -- fresnel rim + travelling scanlines + flicker, for the bot visor.
//
// body-part-batches.js:38 already notes that the lit/fresnel visor lives outside the instanced
// batch table, so this is the module that seam is waiting for. Emissive is deliberately allowed
// above 1.0: the arena runs a bloom node (post-fx.js) and the rim is meant to catch it.
//
// Scanlines ride object-space Y rather than screen space so they stay glued to the visor when
// the camera or the bot moves. That is the difference between "a screen" and "a filter over the
// screen", and only the first one reads correctly in motion.
import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  uniform, vec3, mix, time, positionLocal, normalView, positionViewDirection,
} from 'three/tsl';
import { resolveParams, uniformSeed, buildHandle } from './material-demo-api.js';

export const meta = {
  id: 'hologram-visor',
  name: 'Holographic Visor',
  blurb: 'Fresnel rim, object-space scanlines and flicker. Reads as an active sensor at range.',
  targets: 'Bot visor, scopes, arena screens',
  cost: 'low',
  base: 'MeshStandardNodeMaterial',
  notes: 'Emissive intentionally exceeds 1.0 to drive bloom. Tint is the natural per-team hook.',
  params: [
    { key: 'tint', label: 'Tint', type: 'color', value: 0x4fd6ff },
    { key: 'baseColor', label: 'Glass color', type: 'color', value: 0x0a1016 },
    { key: 'rimStrength', label: 'Rim strength', type: 'float', value: 2.4, min: 0, max: 10, step: 0.05 },
    { key: 'rimPower', label: 'Rim falloff', type: 'float', value: 2.6, min: 0.2, max: 8, step: 0.05,
      hint: 'Higher values tighten the rim to the silhouette edge.' },
    { key: 'scanDensity', label: 'Scanline density', type: 'float', value: 90.0, min: 2, max: 400, step: 1 },
    { key: 'scanSpeed', label: 'Scanline speed', type: 'float', value: 1.6, min: -12, max: 12, step: 0.05 },
    { key: 'scanStrength', label: 'Scanline strength', type: 'float', value: 0.7, min: 0, max: 5, step: 0.02 },
    { key: 'sweepSpeed', label: 'Sweep speed', type: 'float', value: 0.35, min: 0, max: 4, step: 0.01,
      hint: 'A single brighter bar travelling across the visor.' },
    { key: 'sweepStrength', label: 'Sweep strength', type: 'float', value: 1.4, min: 0, max: 8, step: 0.05 },
    { key: 'flickerSpeed', label: 'Flicker speed', type: 'float', value: 11.0, min: 0, max: 60, step: 0.5 },
    { key: 'flickerAmount', label: 'Flicker amount', type: 'float', value: 0.08, min: 0, max: 1, step: 0.01 },
    { key: 'roughness', label: 'Roughness', type: 'float', value: 0.12, min: 0, max: 1, step: 0.01 },
    { key: 'metalness', label: 'Metalness', type: 'float', value: 0.30, min: 0, max: 1, step: 0.01 },
  ],
};

export function create({ params: overrides } = {}) {
  const params = resolveParams(meta, overrides);
  const uniforms = {};
  for (const p of meta.params) uniforms[p.key] = uniform(uniformSeed(p.type, params[p.key]));

  const material = new MeshStandardNodeMaterial();
  material.side = THREE.DoubleSide;

  // Facing ratio: 0 head-on, 1 at the silhouette.
  const facing = normalView.dot(positionViewDirection).clamp(0.0, 1.0);
  const rim = facing.oneMinus().pow(uniforms.rimPower).mul(uniforms.rimStrength);

  // Object-space scanlines so they stay attached to the visor under camera motion.
  const scanPhase = positionLocal.y.mul(uniforms.scanDensity).sub(time.mul(uniforms.scanSpeed));
  const scan = scanPhase.sin().mul(0.5).add(0.5).pow(3.0).mul(uniforms.scanStrength);

  // One brighter bar travelling bottom to top, on a slower clock than the scanlines.
  const sweepPhase = positionLocal.y.mul(1.6).sub(time.mul(uniforms.sweepSpeed)).fract();
  const sweep = sweepPhase.oneMinus().pow(8.0).mul(uniforms.sweepStrength);

  const flicker = time.mul(uniforms.flickerSpeed).sin().mul(0.5).add(0.5)
    .mul(uniforms.flickerAmount).oneMinus();

  material.colorNode = uniforms.baseColor;
  material.roughnessNode = uniforms.roughness;
  material.metalnessNode = uniforms.metalness;
  material.emissiveNode = vec3(uniforms.tint).mul(rim.add(scan).add(sweep)).mul(flicker);

  return buildHandle({ meta, material, uniforms, params });
}
