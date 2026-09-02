/**
 * Assembles a labeled corpus of Chrysalis Engine shapes for ordination: the real states a person
 * has saved, plus synthetic ones so there are enough points for PCA/MDS to say something. As of
 * writing the real corpus is only 3 shapes (`current` plus two named states), too thin on its
 * own.
 *
 * Synthetic configs are drawn from the same min/max ranges as the sliders in
 * chrysalis-engine.html's `bind(...)` calls (RANGES below is a hand-copied mirror of those, not
 * derived from the HTML — keep the two in sync if a slider range changes). Only fields that
 * actually affect chEvaluate are randomized; colors, exposure, camera, and performance knobs
 * don't change the shape and are left at fixed defaults.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeRng } from './chrysalis-shape-embed.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_JSON_PATH = join(__dirname, '..', 'hybrid-tuning', 'chrysalis-engine.json');

export const RANGES = {
  bodyRadius: [0.85, 1.55],
  organicWarpAmp: [0, 1.2],
  organicWarpFalloff: [0.65, 1.8],
  organicWarpFrequency: [1, 9],
  organicWarpVelocity: [-1.2, 1.2],
  organicRelief: [0, 0.72],
  organicPulse: [0, 0.15],
  cellStructure: [0, 1],
  coreRadius: [0, 0.48],
  crystalScale: [0.9, 2.0],
  crystalRotX: [-Math.PI, Math.PI],
  crystalRotY: [-Math.PI, Math.PI],
  crystalRotZ: [-Math.PI, Math.PI],
  crystalStiffness: [0.25, 3.0],
  facetFrequency: [0.5, 9],
  facetRelief: [0, 0.22],
  frontRelief: [0, 0.28],
  growthFeather: [0.02, 0.40],
  veinAffinity: [-1.5, 1.5],
  globalGrowth: [0, 1],
};

/** outerSteps/stepSafety affect marching precision, not shape, so synthetic configs fix them. */
const TRACE_DEFAULTS = { outerSteps: 96, stepSafety: 0.46 };

export function loadRealStates(jsonPath = DEFAULT_JSON_PATH) {
  const doc = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const entries = [];
  if (doc.current) entries.push({ name: 'current', config: doc.current.config, seeds: doc.current.seeds ?? [], real: true });
  for (const [name, state] of Object.entries(doc.states ?? {})) {
    entries.push({ name, config: state.config, seeds: state.seeds ?? [], real: true });
  }
  return entries;
}

function randomUnitVector(rng) {
  const y = rng() * 2 - 1;
  const angle = rng() * Math.PI * 2;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  return [Math.cos(angle) * r, y, Math.sin(angle) * r];
}

export function randomConfig(rng) {
  const config = { ...TRACE_DEFAULTS };
  for (const [key, [min, max]] of Object.entries(RANGES)) {
    config[key] = min + rng() * (max - min);
  }
  return config;
}

export function randomSeeds(rng, { minCount = 1, maxCount = 5 } = {}) {
  const count = minCount + Math.floor(rng() * (maxCount - minCount + 1));
  const seeds = [];
  for (let i = 0; i < count; i++) {
    seeds.push({
      direction: randomUnitVector(rng),
      radius: rng() * (Math.PI + 0.4),
      strength: 1,
      polarity: rng() < 0.85 ? 1 : -1,
      speed: 1,
    });
  }
  return seeds;
}

/** Real states plus `syntheticCount` random ones, each tagged `real: true/false`. */
export function buildCorpus({ syntheticCount = 20, seed = 42, jsonPath = DEFAULT_JSON_PATH } = {}) {
  const entries = loadRealStates(jsonPath);
  const rng = makeRng(seed);
  for (let i = 0; i < syntheticCount; i++) {
    entries.push({
      name: `synthetic-${i}`,
      config: randomConfig(rng),
      seeds: randomSeeds(rng),
      real: false,
    });
  }
  return entries;
}
