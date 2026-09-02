/**
 * Pure-JS twin of chEvaluate/chDistance in chrysalis-field.js's CHRYSALIS_GLSL.
 *
 * Same role as forest-cull.js mirroring forest-gpu.js: this makes the SDF unit-testable and
 * sampleable in Node, with no THREE, no DOM, no WebGL. It is NOT imported by chrysalis-field.js
 * or chrysalis-engine.html and will drift silently if the GLSL changes without this being
 * updated by hand.
 *
 * All functions take/return plain [x, y, z] arrays rather than a vector class, since nothing
 * here needs anything past add/scale/dot/length.
 *
 * `time` is a caller-supplied scalar rather than something this module tracks, because comparing
 * shapes across a corpus wants every shape sampled at the same instant (0 by default) rather than
 * each shape's own accumulated animation clock.
 */

const CHRYSALIS_MAX_SEEDS = 8;
const CHRYSALIS_CELL_ITERS = 7;

function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function length3(a) { return Math.sqrt(dot3(a, a)); }
function sub3(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function add3(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function scale3(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
function mix3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
function abs3(a) { return [Math.abs(a[0]), Math.abs(a[1]), Math.abs(a[2])]; }
function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
function mix(a, b, t) { return a + (b - a) * t; }
function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
function normalize3(a) {
  const l = length3(a) || 1e-9;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** Rotates the (p[i], p[j]) pair by angle a, matching GLSL's `p.xy *= chRot(a)` convention. */
function rot2(p, i, j, a) {
  const c = Math.cos(a), s = Math.sin(a);
  const x = p[i], y = p[j];
  p[i] = c * x - s * y;
  p[j] = s * x + c * y;
}

function chSmoothMax(a, b, k) {
  const h = clamp(0.5 - 0.5 * (b - a) / Math.max(k, 0.0001), 0, 1);
  return mix(b, a, h) + k * h * (1 - h);
}

function chHash(p) {
  const s = Math.sin(dot3(p, [12.9898, 78.283, 37.919])) * 43758.7053;
  return s - Math.floor(s);
}

function chValueNoise(p) {
  const i = p.map(Math.floor);
  const f = [p[0] - i[0], p[1] - i[1], p[2] - i[2]];
  const u = f.map((v) => v * v * (3 - 2 * v));
  const at = (dx, dy, dz) => chHash([i[0] + dx, i[1] + dy, i[2] + dz]);
  const n000 = at(0, 0, 0), n100 = at(1, 0, 0), n010 = at(0, 1, 0), n110 = at(1, 1, 0);
  const n001 = at(0, 0, 1), n101 = at(1, 0, 1), n011 = at(0, 1, 1), n111 = at(1, 1, 1);
  const nx00 = mix(n000, n100, u[0]);
  const nx10 = mix(n010, n110, u[0]);
  const nx01 = mix(n001, n101, u[0]);
  const nx11 = mix(n011, n111, u[0]);
  return mix(nx00, nx10, u[1]) * (1 - u[2]) + mix(nx01, nx11, u[1]) * u[2];
}

function chWarpDirection(direction, config, time) {
  let q = scale3(direction, 0.4);
  let frequency = config.organicWarpFrequency;
  let power = Math.pow(Math.max(config.organicWarpFalloff, 0.55), config.organicWarpFrequency);
  const phase = time * config.organicWarpVelocity;
  for (let i = 0; i < 6; i++) {
    const offset = [
      Math.sin(q[1] * power + phase + frequency * 0.18),
      Math.sin(q[2] * power + phase + frequency * 0.21),
      Math.sin(q[0] * power + phase + frequency * 0.24),
    ];
    q = add3(q, scale3(offset, config.organicWarpAmp / Math.max(power, 0.35)));
    frequency += 1;
    power *= Math.max(config.organicWarpFalloff, 0.55);
  }
  return q;
}

function chSortFold(p) {
  p[0] = Math.abs(p[0]); p[1] = Math.abs(p[1]); p[2] = Math.abs(p[2]);
  if (p[0] < p[1]) { const t = p[0]; p[0] = p[1]; p[1] = t; }
  if (p[0] < p[2]) { const t = p[0]; p[0] = p[2]; p[2] = t; }
  if (p[1] < p[2]) { const t = p[1]; p[1] = p[2]; p[2] = t; }
}

const ALIEN_SCALE = 1.72;
const ALIEN_OFFSET = [0.76, 0.70, 0.36];

/** Returns { d, trap: [x,y,z] }, mirroring chAlienTissue's vec4 (distance, trap). */
function chAlienTissue(p, config, time) {
  const originalP = [p[0], p[1], p[2]];
  const q = [p[0], p[1], p[2]];
  rot2(q, 0, 2, 0.08 * Math.sin(time * 0.18));
  rot2(q, 1, 2, 0.06 * Math.sin(time * 0.13));
  const z = [q[0], q[1], q[2]];
  let scaleTracker = 1.4;
  let trap = [10, 10, 10];
  for (let i = 0; i < CHRYSALIS_CELL_ITERS; i++) {
    chSortFold(z);
    rot2(z, 0, 1, 0.65539816339);
    rot2(z, 0, 2, 0.40269908169);
    rot2(z, 1, 2, 0.17179938779);
    z[0] = z[0] * ALIEN_SCALE - ALIEN_OFFSET[0] * (ALIEN_SCALE - 1.1);
    z[1] = z[1] * ALIEN_SCALE - ALIEN_OFFSET[1] * (ALIEN_SCALE - 1.1);
    z[2] = z[2] * ALIEN_SCALE - ALIEN_OFFSET[2] * (ALIEN_SCALE - 1.1);
    scaleTracker *= ALIEN_SCALE;
    trap = [Math.min(trap[0], Math.abs(z[0])), Math.min(trap[1], Math.abs(z[1])), Math.min(trap[2], Math.abs(z[2]))];
  }
  const fractal = (length3(z) - 1.22) / scaleTracker;
  const boundary = length3([originalP[0] / 1.18, originalP[1] / 0.78, originalP[2] / 1.12]) - 1.08;
  const coreVoid = config.coreRadius - length3(originalP);
  return { d: Math.max(Math.max(fractal, boundary), coreVoid), trap };
}

function chRotateCrystal(p, config) {
  const q = [p[0], p[1], p[2]];
  rot2(q, 1, 2, config.crystalRotX);
  rot2(q, 0, 2, config.crystalRotY);
  rot2(q, 0, 1, config.crystalRotZ);
  return q;
}

function chDiamond(p, scale) {
  const s = Math.max(scale, 0.01);
  let x = p[0] / s, y = p[1] / s, z = p[2] / s;
  x = Math.abs(x); z = Math.abs(z);
  if (x < z) { const t = x; x = z; z = t; }
  const px = x * 1.0338795 + z * 0.3826834;
  const crownDir = normalize3([1, 0.7, 0]);
  const pavilionDir = normalize3([1.7, -1.1, 0]);
  const dCrown = (px * crownDir[0] + y * crownDir[1]) - 0.8371;
  const dPavilion = (px * pavilionDir[0] + y * pavilionDir[1]) - 0.7382;
  const dTable = y - 0.4;
  return Math.max(Math.max(dCrown, dPavilion), dTable) * scale * 0.91;
}

const CRYSTAL_BASIS = [
  [-0.131464913, -0.048044873, 0.062087367],
  [-0.465078618, -0.016973341, 0.454042493],
  [0.086597072, 1.681518454, 0.009753815],
];
const GOLDEN_RATIO = 2.788033988;

function fractComponent(v) { return v - Math.floor(v); }

function chCrystalDisturbance(position) {
  const p = [dot3(position, CRYSTAL_BASIS[0]), dot3(position, CRYSTAL_BASIS[1]), dot3(position, CRYSTAL_BASIS[2])];
  const tri1 = p.map((v) => Math.abs(fractComponent(v) * 2 - 1));
  const tri2 = p.map((v) => Math.abs(fractComponent(v * GOLDEN_RATIO) * 2.1 - 1));
  return (Math.max(Math.max(tri1[0], tri1[1]), tri1[2]) + dot3(tri1, tri2) * 0.5) * 0.6;
}

function chTrapVeins(trap) {
  return clamp(
    Math.exp(-12 * trap[0]) * 0.53 + Math.exp(-10 * trap[1]) * 0.50 + Math.exp(-8 * trap[2]) * 0.35,
    0, 1,
  );
}

function chGrowthField(direction, trap, config, seeds) {
  let positive = clamp(config.globalGrowth, 0, 1);
  let negative = 0;
  const veinShift = (chTrapVeins(trap) - 0.35) * config.veinAffinity * 0.16;
  const count = Math.min(seeds.length, CHRYSALIS_MAX_SEEDS);
  for (let i = 0; i < count; i++) {
    const seed = seeds[i];
    const seedDirection = normalize3(seed.direction);
    const angle = Math.acos(clamp(dot3(direction, seedDirection), -1, 1));
    const wave = (1 - smoothstep(seed.radius - config.growthFeather, seed.radius + config.growthFeather, angle - veinShift)) * seed.strength;
    if (seed.polarity >= 0) positive = Math.max(positive, wave);
    else negative = Math.max(negative, wave);
  }
  return clamp(positive - negative, 0, 1);
}

/**
 * Evaluates the hybrid field at one point. Returns the same fields as the shader's
 * ChrysalisSample struct: d, growth, front, stress, organicDistance, crystalDistance,
 * disturbance, trap.
 */
export function chEvaluate(p, config, seeds, time = 0) {
  const radius = Math.max(length3(p), 0.0001);
  const direction = scale3(p, 1 / radius);
  const warpedDirection = chWarpDirection(direction, config, time);
  const membraneNoise = chValueNoise(add3(scale3(warpedDirection, 3.1), [time * 0.18, time * 0.18, time * 0.18]));
  let radialRelief = (smoothstep(0.18, 0.82, membraneNoise) - 0.5) * config.organicRelief;
  radialRelief += Math.sin(time * 1.15 - radius * 6.5) * config.organicPulse;
  const pBio = sub3(p, scale3(direction, radialRelief));

  const alien = chAlienTissue(pBio, config, time);
  const dMembrane = radius - config.bodyRadius - radialRelief;
  const dIntersection = chSmoothMax(dMembrane, alien.d, 0.12);
  const dOrganic = mix(dMembrane, dIntersection, config.cellStructure);

  const growth = chGrowthField(direction, alien.trap, config, seeds);
  const stiffness = Math.pow(growth, Math.max(config.crystalStiffness, 0.05));
  const pPhase = mix3(pBio, p, stiffness);
  const crystalP = chRotateCrystal(pPhase, config);
  const disturbance = chCrystalDisturbance(scale3(crystalP, config.facetFrequency));
  let dCrystal = chDiamond(crystalP, config.crystalScale);
  dCrystal -= (disturbance - 0.48) * config.facetRelief;

  const front = 4 * growth * (1 - growth);
  const stress = length3(sub3(pBio, p)) * front;
  let d = mix(dOrganic, dCrystal, growth);
  d -= front * config.frontRelief * (disturbance - 0.35);
  d = Math.max(d, config.coreRadius - radius);

  return { d, growth, front, stress, organicDistance: dOrganic, crystalDistance: dCrystal, disturbance, trap: alien.trap };
}

export function chDistance(p, config, seeds, time = 0) {
  return chEvaluate(p, config, seeds, time).d;
}

const NORMAL_EPS = 0.0035;
const NORMAL_K = [
  [1, -1, -1],
  [-1, -1, 1],
  [-1, 1, -1],
  [1, 1, 1],
];

export function chNormal(p, config, seeds, time = 0) {
  let n = [0, 0, 0];
  for (const k of NORMAL_K) {
    const sample = add3(p, scale3(k, NORMAL_EPS));
    const d = chDistance(sample, config, seeds, time);
    n = add3(n, scale3(k, d));
  }
  return normalize3(n);
}
