// foliage-sss.js -- cheap wrapped translucency, so leaves and grass light up when the sun is
// behind them.
//
// This is the Frostbite/DICE fake-SSS approximation, not real subsurface transport: the light
// vector is bent by the surface normal, then the result is a view-dependent lobe added as
// emissive. No extra pass, no backbuffer read, one dot product and a pow.
//
// It is on the foliage rather than the bots deliberately. Bots are the instanced hot path
// (body-part-batches.js) where added per-pixel shading cost multiplies; trees and grass are
// already GPU-driven and frustum-culled, so this rides an existing budget.
//
// `lightDirection` is the direction from the surface TOWARD the light, which is what you get
// from normalising a three.js DirectionalLight's position.
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  uniform, vec3, positionWorld, normalWorld, cameraPosition, mx_noise_float,
} from 'three/tsl';
import { resolveParams, uniformSeed, buildHandle } from './material-demo-api.js';

export const meta = {
  id: 'foliage-sss',
  name: 'Foliage Backlight (fake SSS)',
  blurb: 'Wrapped translucency lobe. Leaves glow when lit from behind, for one dot and a pow.',
  targets: 'Trees, grass, understory plants',
  cost: 'low',
  base: 'MeshStandardNodeMaterial',
  notes: 'Set `lightDirection` from your sun each frame. Deliberately not aimed at instanced bots.',
  params: [
    { key: 'baseColor', label: 'Leaf color', type: 'color', value: 0x3f7a2e },
    { key: 'sssColor', label: 'Transmit color', type: 'color', value: 0xa8d94a,
      hint: 'The colour light takes on passing through the leaf. Warmer and brighter than the base.' },
    { key: 'lightDirection', label: 'Light direction', type: 'vec3', value: [0.45, 0.75, 0.35],
      hint: 'Surface toward the light. Normalised sun position.' },
    { key: 'distortion', label: 'Normal distortion', type: 'float', value: 0.35, min: 0, max: 2, step: 0.01,
      hint: 'How far the normal bends the transmitted light vector.' },
    { key: 'power', label: 'Lobe tightness', type: 'float', value: 3.0, min: 0.5, max: 16, step: 0.1 },
    { key: 'strength', label: 'Transmit strength', type: 'float', value: 1.5, min: 0, max: 8, step: 0.05 },
    { key: 'thickness', label: 'Thickness', type: 'float', value: 0.7, min: 0, max: 1, step: 0.01,
      hint: 'Thinner leaves transmit more. Scaled by the variation term below.' },
    { key: 'thicknessVariation', label: 'Thickness variation', type: 'float', value: 0.35, min: 0, max: 1, step: 0.01 },
    { key: 'variationScale', label: 'Variation scale', type: 'float', value: 4.0, min: 0.1, max: 30, step: 0.1 },
    { key: 'ambient', label: 'Ambient transmit', type: 'float', value: 0.12, min: 0, max: 1, step: 0.01,
      hint: 'A floor so leaves never go fully black in shadow.' },
    { key: 'roughness', label: 'Roughness', type: 'float', value: 0.78, min: 0, max: 1, step: 0.01 },
  ],
};

export function create({ params: overrides } = {}) {
  const params = resolveParams(meta, overrides);
  const uniforms = {};
  for (const p of meta.params) uniforms[p.key] = uniform(uniformSeed(p.type, params[p.key]));

  const material = new MeshStandardNodeMaterial();
  material.side = 2;   // THREE.DoubleSide; leaves are single-sided cards

  const viewDir = cameraPosition.sub(positionWorld).normalize();
  const lightDir = uniforms.lightDirection.normalize();

  // Bend the light vector by the normal, then look for the camera along its reverse.
  const transmitDir = lightDir.add(normalWorld.mul(uniforms.distortion)).normalize();
  const lobe = viewDir.dot(transmitDir.negate()).clamp(0.0, 1.0).pow(uniforms.power);

  // Per-fragment thickness jitter so a leaf canopy does not transmit as one flat sheet.
  const jitter = mx_noise_float(positionWorld.mul(uniforms.variationScale)).mul(0.5).add(0.5);
  const thickness = uniforms.thickness.mul(
    jitter.mul(uniforms.thicknessVariation).add(uniforms.thicknessVariation.oneMinus()),
  );

  const transmit = lobe.add(uniforms.ambient).mul(thickness).mul(uniforms.strength);

  material.colorNode = uniforms.baseColor;
  material.roughnessNode = uniforms.roughness;
  material.metalnessNode = 0;
  material.emissiveNode = vec3(uniforms.sssColor).mul(transmit);

  return buildHandle({ meta, material, uniforms, params });
}
