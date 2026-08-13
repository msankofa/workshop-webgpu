// damage-overheat.js -- scorch blotches plus emissive cracks, driven by the health the game
// already tracks.
//
// Two independent inputs on purpose: `damage` is permanent accumulation (scorch spreads,
// roughness climbs, metalness burns off), `heat` is transient (cracks glow, then cool). A bot
// can be heavily damaged and cold, or fresh and glowing from a single hit.
//
// The point is gameplay readability. A wounded bot should be identifiable at range without a
// health bar, which is what makes focus-fire legible to the player.
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  uniform, float, vec3, mix, smoothstep, time, positionLocal,
  mx_noise_float, mx_fractal_noise_float,
} from 'three/tsl';
import { resolveParams, uniformSeed, buildHandle } from './material-demo-api.js';

export const meta = {
  id: 'damage-overheat',
  name: 'Damage / Overheat',
  blurb: 'Scorch spread and glowing cracks driven by health. Readable at range with no HUD.',
  targets: 'Bot shell, destructible props',
  cost: 'low',
  base: 'MeshStandardNodeMaterial',
  notes: 'Wire `damage` to 1 - health/maxHealth and pulse `heat` on each hit, decaying to 0.',
  rebuildOn: ['scorchOctaves'],
  params: [
    { key: 'damage', label: 'Damage', type: 'float', value: 0.55, min: 0, max: 1, step: 0.001,
      hint: 'Permanent. Spreads scorch and roughens the surface.' },
    { key: 'heat', label: 'Heat', type: 'float', value: 0.6, min: 0, max: 1, step: 0.001,
      hint: 'Transient. Lights the cracks. Decay this after each hit.' },
    { key: 'baseColor', label: 'Base color', type: 'color', value: 0x9aa3ad },
    { key: 'scorchColor', label: 'Scorch color', type: 'color', value: 0x1b1714 },
    { key: 'crackColor', label: 'Crack color', type: 'color', value: 0xff5a1e },
    { key: 'crackScale', label: 'Crack scale', type: 'float', value: 7.5, min: 0.5, max: 40, step: 0.1 },
    { key: 'crackWidth', label: 'Crack width', type: 'float', value: 0.12, min: 0.01, max: 0.6, step: 0.005 },
    { key: 'crackIntensity', label: 'Crack glow', type: 'float', value: 6.0, min: 0, max: 25, step: 0.1 },
    { key: 'scorchScale', label: 'Scorch scale', type: 'float', value: 2.1, min: 0.2, max: 20, step: 0.1 },
    { key: 'scorchOctaves', label: 'Scorch octaves', type: 'float', value: 3, min: 1, max: 6, step: 1,
      hint: 'Rebuilds the material when changed.' },
    { key: 'pulseSpeed', label: 'Heat pulse speed', type: 'float', value: 3.2, min: 0, max: 20, step: 0.1 },
    { key: 'pulseAmount', label: 'Heat pulse depth', type: 'float', value: 0.25, min: 0, max: 1, step: 0.01 },
    { key: 'roughness', label: 'Base roughness', type: 'float', value: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'metalness', label: 'Base metalness', type: 'float', value: 0.35, min: 0, max: 1, step: 0.01 },
  ],
};

export function create({ params: overrides } = {}) {
  const params = resolveParams(meta, overrides);
  const uniforms = {};
  for (const p of meta.params) {
    if (meta.rebuildOn.includes(p.key)) continue;
    uniforms[p.key] = uniform(uniformSeed(p.type, params[p.key]));
  }
  const scorchOctaves = Math.max(1, Math.round(params.scorchOctaves));

  const material = new MeshStandardNodeMaterial();

  // Ridged noise: |n| inverted peaks at the zero crossings, which is where the cracks run.
  const ridge = mx_noise_float(positionLocal.mul(uniforms.crackScale)).abs().oneMinus();
  const crack = smoothstep(uniforms.crackWidth.oneMinus(), float(1.0), ridge);

  // Broad blotches. As damage rises the threshold drops, so scorched area grows.
  const blotch = mx_fractal_noise_float(
    positionLocal.mul(uniforms.scorchScale), scorchOctaves, float(2.0), float(0.5), float(1.0),
  ).mul(0.5).add(0.5);
  const scorch = smoothstep(uniforms.damage.oneMinus(), uniforms.damage.oneMinus().add(0.25), blotch)
    .mul(uniforms.damage);

  const pulse = time.mul(uniforms.pulseSpeed).sin().mul(0.5).add(0.5)
    .mul(uniforms.pulseAmount).add(uniforms.pulseAmount.oneMinus());

  // Cracks only light where the shell is actually damaged, so a pristine bot never glows.
  const crackGlow = crack.mul(uniforms.damage).mul(uniforms.heat).mul(uniforms.crackIntensity).mul(pulse);

  material.colorNode = mix(vec3(uniforms.baseColor), vec3(uniforms.scorchColor), scorch);
  material.roughnessNode = mix(uniforms.roughness, float(0.95), scorch);
  material.metalnessNode = mix(uniforms.metalness, uniforms.metalness.mul(0.3), scorch);
  material.emissiveNode = vec3(uniforms.crackColor).mul(crackGlow);

  return buildHandle({ meta, material, uniforms, params });
}
