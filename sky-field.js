// sky-field.js
// Pure-JS night-sky generators — NO three.js import. CPU source of truth the TSL
// rendering modules (sky.js / stars.js / celestial-bodies.js) consume, and the
// Node-tested guard. Mirrors particle-field.js: deterministic math, no DOM/GPU.

// A single tunable night palette (this project has one continuous environment, so
// there are no per-map presets). Colors are hex strings; three parses them later.
export const DEFAULT_PALETTE = {
  top:        '#0a1026',   // zenith
  horizon:    '#243b66',   // horizon band
  bottom:     '#0b1430',   // below horizon
  glow:       '#3a5a8c',   // horizon glow tint
  sun:        '#fff4e0',   // warm sun disc
  moonColor:  '#dfe7ff',   // cool moon disc
  sunSize:    0.06,        // sprite size as a fraction of sky radius
  sunOpacity: 1.0,         // <0.6 infers a moon when celestialType is unset
  celestialType: 'sun',    // 'sun' | 'moon' — explicit primary-body choice
  starColor:  '#dfe8ff',
  starCount:  1400,
  starOpacity: 1.0,
  starSize:   2.2,         // base point size in px (size attenuation off)
  milkyWay:   true,
  milkyWayIntensity: 0.7,
};

export function makePalette(overrides = {}) {
  return Object.assign({}, DEFAULT_PALETTE, overrides);
}

// ---- Time-of-day dome states -------------------------------------------------
// Three keyframed dome parameter sets blended by sun elevation. `night` reproduces
// today's DEFAULT_PALETTE look plus the transition constants that used to be baked into
// sky.js's colorNode (zenithSoftness 0.55, glowWidth ~= 1/9, glowStrength 0.4).
export const DEFAULT_SKY_STATES = {
  day:   { top: '#2b6bd6', horizon: '#bcd4f0', bottom: '#7fa8d8', glow: '#e8eef6',
           horizonHeight: 0.0, zenithSoftness: 0.55, glowWidth: 0.11, glowStrength: 0.25 },
  dusk:  { top: '#1a2a5c', horizon: '#c85a3c', bottom: '#2a1a3e', glow: '#ff8a4a',
           horizonHeight: 0.0, zenithSoftness: 0.50, glowWidth: 0.18, glowStrength: 0.60 },
  night: { top: '#0a1026', horizon: '#243b66', bottom: '#0b1430', glow: '#3a5a8c',
           horizonHeight: 0.0, zenithSoftness: 0.55, glowWidth: 0.11, glowStrength: 0.40 },
};

// Sun-elevation anchors (degrees) that select / blend the states.
export const DEFAULT_THRESHOLDS = { dayAbove: 8, duskPeak: 0, nightBelow: -8 };

const SKY_COLOR_KEYS = ['top', 'horizon', 'bottom', 'glow'];
const SKY_NUM_KEYS = ['horizonHeight', 'zenithSoftness', 'glowWidth', 'glowStrength'];

export function makeSkyStates(overrides = {}) {
  const out = {};
  for (const k of ['day', 'dusk', 'night']) out[k] = Object.assign({}, DEFAULT_SKY_STATES[k], overrides[k] || {});
  return out;
}

function hex2rgb(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function ch(v) { return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'); }
// Linear RGB-space hex interpolation. Endpoints are exact (integer identity), so a state
// returned at its own anchor elevation is byte-for-byte that state's color.
export function lerpHex(a, b, t) {
  const A = hex2rgb(a), B = hex2rgb(b);
  return '#' + ch(A[0] + (B[0] - A[0]) * t) + ch(A[1] + (B[1] - A[1]) * t) + ch(A[2] + (B[2] - A[2]) * t);
}

function lerpState(a, b, t) {
  const out = {};
  for (const k of SKY_COLOR_KEYS) out[k] = lerpHex(a[k], b[k], t);
  for (const k of SKY_NUM_KEYS) out[k] = a[k] + (b[k] - a[k]) * t;
  return out;
}

// Dome parameter set for a sun elevation. Only ever blends ADJACENT, explicitly-authored
// states (day<->dusk, dusk<->night), so colors never take a muddy direct blue->red
// midpoint. Clamps to day above `dayAbove` and to night below `nightBelow`.
export function domeParamsAtElevation(elevDeg, thresholds = DEFAULT_THRESHOLDS, states = DEFAULT_SKY_STATES) {
  const { dayAbove, duskPeak, nightBelow } = thresholds;
  const { day, dusk, night } = states;
  if (elevDeg >= dayAbove) return lerpState(day, day, 0);
  if (elevDeg <= nightBelow) return lerpState(night, night, 0);
  if (elevDeg >= duskPeak) return lerpState(dusk, day, (elevDeg - duskPeak) / (dayAbove - duskPeak));
  return lerpState(night, dusk, (elevDeg - nightBelow) / (duskPeak - nightBelow));
}

function smooth01(e0, e1, x) { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }
// 0 in full day, 1 in full night, smooth through dusk. Monotonic non-increasing in elevation.
export function nightnessAtElevation(elevDeg, thresholds = DEFAULT_THRESHOLDS) {
  return 1 - smooth01(thresholds.nightBelow, thresholds.dayAbove, elevDeg);
}

// Sky dome radius (faithful to the source spec).
export function skyRadius(far, size) {
  return Math.min(far * 0.88, Math.max(420, (Number(size) || 120) * 2.65));
}

// Primary body identity: explicit type wins; otherwise infer from sun opacity.
export function isMoonBody(palette) {
  if (palette.celestialType === 'moon') return true;
  if (palette.celestialType === 'sun') return false;
  return palette.sunOpacity < 0.6;
}

// Sprite world placement along the (un-normalized) light direction.
export function sunSpritePlacement(dir, radius, palette) {
  const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const r = radius * 0.74;
  const moon = isMoonBody(palette);
  return {
    position: { x: dir[0] / len * r, y: dir[1] / len * r, z: dir[2] / len * r },
    scale: radius * palette.sunSize * 2.15 * (moon ? 2.4 : 1),
    isMoon: moon,
  };
}

// Mulberry32: tiny deterministic PRNG → () => [0,1).
export function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One unit-sphere point on the upper hemisphere (y in [0.06, 0.96]).
function hemiDir(rng) {
  const theta = rng() * Math.PI * 2;
  const y = 0.06 + rng() * 0.9;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  return { x: Math.cos(theta) * r, y, z: Math.sin(theta) * r };
}

// Nudge a unit direction by a small angular spread, re-projected onto the sphere.
function jitterDir(center, spread, rng) {
  const x = center.x + (rng() * 2 - 1) * spread;
  const y = Math.max(0.06, center.y + (rng() * 2 - 1) * spread);
  const z = center.z + (rng() * 2 - 1) * spread;
  const len = Math.hypot(x, y, z) || 1;
  return { x: x / len, y: y / len, z: z / len };
}

// Generate the star point cloud: positions on the 0.83R shell plus per-star twinkle
// attributes. A dense sky reserves a few stars for 1-3 Pleiades-like clusters; clustered
// and background stars share one geometry (one draw call downstream).
export function generateStars(radius, palette, rng) {
  const count = palette.starCount | 0;
  const shell = radius * 0.83;
  const position = new Float32Array(count * 3);
  const brightness = new Float32Array(count);
  const phase = new Float32Array(count);
  const speed = new Float32Array(count);
  const strength = new Float32Array(count);
  const size = new Float32Array(count);

  // Decide cluster reservation (only for reasonably dense skies).
  const clusterCount = count >= 800 ? 1 + ((rng() * 3) | 0) : 0;
  const clusters = [];
  let reserved = 0;
  for (let c = 0; c < clusterCount; c++) {
    const core = 6 + ((rng() * 5) | 0);     // tight bright core
    const ring = 10 + ((rng() * 11) | 0);   // looser faint halo
    if (reserved + core + ring > count) break;
    clusters.push({ center: hemiDir(rng), core, ring, start: reserved });
    reserved += core + ring;
  }

  const writeStar = (i, dir, bright, big) => {
    position[i * 3] = dir.x * shell;
    position[i * 3 + 1] = dir.y * shell;
    position[i * 3 + 2] = dir.z * shell;
    brightness[i] = bright;
    phase[i] = rng() * Math.PI * 2;
    speed[i] = 0.5 + rng() * 2.0;
    strength[i] = 0.15 + rng() * 0.5;
    const prominent = big || rng() < 0.04;
    size[i] = palette.starSize * (prominent ? 2.0 + rng() * 2.0 : 0.6 + rng() * 0.8);
  };

  // Clustered stars first (indices [0, reserved)).
  for (const cl of clusters) {
    let i = cl.start;
    for (let k = 0; k < cl.core; k++, i++) {
      const d = jitterDir(cl.center, 0.012, rng);
      writeStar(i, d, 0.85 + rng() * 0.15, true);
    }
    for (let k = 0; k < cl.ring; k++, i++) {
      const d = jitterDir(cl.center, 0.05, rng);
      writeStar(i, d, 0.62 + rng() * 0.3, false);
    }
  }
  // Background stars fill the rest.
  for (let i = reserved; i < count; i++) {
    writeStar(i, hemiDir(rng), 0.62 + rng() * 0.38, false);
  }

  return { count, position, brightness, phase, speed, strength, size, clusterCount };
}

// Milky Way band: a dense ring of points on a tilted great circle (the galactic plane),
// each spread off-plane by a falloff so it reads as a band, not a wire. Returns null for
// bright/day palettes (milkyWay === false).
export function generateMilkyWay(radius, palette, rng) {
  if (!palette.milkyWay) return null;
  const shell = radius * 0.82;
  // Density multiplier (band points per star); defaults to 1.1 so an unset palette matches the
  // historic count. Exposed as the "Milky Way density" control.
  const bandCount = Math.round((palette.starCount || 1400) * (palette.milkyWayDensity ?? 1.1));
  const position = new Float32Array(bandCount * 3);
  const brightness = new Float32Array(bandCount);
  const phase = new Float32Array(bandCount);
  const speed = new Float32Array(bandCount);
  const size = new Float32Array(bandCount);
  const tilt = 0.5 + rng() * 0.5;            // radians, band tilt across the sky
  const cosT = Math.cos(tilt), sinT = Math.sin(tilt);
  for (let i = 0; i < bandCount; i++) {
    const a = rng() * Math.PI * 2;
    // Off-plane gaussian-ish spread (sum of uniforms) → denser core, soft edges.
    const off = ((rng() + rng() + rng()) / 3 * 2 - 1) * 0.16;
    let x = Math.cos(a), y = off, z = Math.sin(a);
    const len = Math.hypot(x, y, z); x /= len; y /= len; z /= len;
    // Tilt the plane about the X axis.
    const ty = y * cosT - z * sinT, tz = y * sinT + z * cosT;
    position[i*3] = x * shell; position[i*3+1] = ty * shell; position[i*3+2] = tz * shell;
    brightness[i] = 0.35 + rng() * 0.5;       // dimmer than foreground stars
    phase[i] = rng() * Math.PI * 2;
    speed[i] = 0.3 + rng() * 1.0;             // gentler twinkle
    size[i] = (palette.starSize || 2) * (0.4 + rng() * 0.6);
  }
  return { bandCount, position, brightness, phase, speed, size, tilt };
}

// Exported (not just internal to generateCelestialBodies) so dev tools like
// stellar-viewer.html can build kind/color pickers without duplicating this list.
export const PLANET_KINDS = ['terrestrial', 'gas', 'ice', 'volcanic', 'rocky'];
const KIND_WEIGHTS = [0.28, 0.22, 0.18, 0.12, 0.20];
export const MOON_KINDS = ['ice', 'rocky'];
const MOON_WEIGHTS = [0.55, 0.45];

// Continuous per-kind color generation (HSL), NOT a fixed swatch list — a small hardcoded
// array (even a 5-6 entry one) caps how many distinct colors can ever appear, no matter how
// spread out its entries are. Hue is fully random (0-360) for every kind, so there's no upper
// bound on distinct colors; only saturation/lightness are loosely bounded per kind so each kind
// still reads as its category (pale for ice, dark/charred for volcanic, etc.) rather than the
// hue itself being restricted.
const KIND_COLOR_RANGE = {
  terrestrial: { s: [35, 65], l: [30, 55] },
  gas:         { s: [35, 70], l: [40, 65] },
  ice:         { s: [5, 30], l: [70, 90] },
  volcanic:    { s: [40, 70], l: [10, 25] },
  rocky:       { s: [10, 40], l: [25, 55] },
};
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = x => Math.round(clamp01(x) * 255).toString(16).padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}
function clamp01(x) { return Math.max(0, Math.min(1, x)); }
// Sampling hue uniformly over [0, 360) is uniform in DEGREES but not in perceived color:
// "green" spans roughly 100 of those degrees and "purple/magenta" roughly 75, versus ~30 each
// for red/orange/yellow — so a flat draw picks green or purple nearly half the time (measured
// ~28%/~21%). Evenly-spacing anchors by degree doesn't fix this either — it just discretizes
// the same bias (more anchors still land inside the wide green/purple bands). Instead, each
// anchor below is hand-placed at the center of one named color (red/orange/yellow/green/
// cyan/blue/purple/pink), one anchor per name — so every name gets an equal 1-in-8 shot
// regardless of how many raw degrees its band happens to span, and jitter still gives
// continuous, non-repeating variation within each name.
const HUE_FAMILIES = [0, 30, 58, 110, 185, 225, 290, 337];
export function randomKindColor(rng, kind) {
  const range = KIND_COLOR_RANGE[kind];
  const anchor = HUE_FAMILIES[(rng() * HUE_FAMILIES.length) | 0];
  const h = (anchor + (rng() * 2 - 1) * 14 + 360) % 360;
  const s = range.s[0] + rng() * (range.s[1] - range.s[0]);
  const l = range.l[0] + rng() * (range.l[1] - range.l[0]);
  return hslToHex(h, s, l);
}

function weightedPick(rng, items, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

// Extra moons + distant/near planets + the near planet's companion moons. Each body is a
// plain descriptor (type, world position on its own radius, size, color, flags) the TSL
// celestial-bodies module turns into a sprite. Night/dusk only (caller gates on palette).
export function generateCelestialBodies(radius, palette, rng) {
  const out = [];
  // Global size multiplier on generated bodies (the "Planet/moon size" control). Count
  // overrides (planetCount/moonCount) still consume their RNG draw when set, so overriding a
  // count doesn't reshuffle the rest of the sky's stream more than the count change itself.
  const bodyScale = palette.bodyScale ?? 1;
  const place = (dir, r) => {
    const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
    return { x: dir.x / len * r, y: dir.y / len * r, z: dir.z / len * r };
  };
  const dir = () => {
    const theta = rng() * Math.PI * 2;
    const y = 0.15 + rng() * 0.7;
    const rr = Math.sqrt(Math.max(0, 1 - y * y));
    return { x: Math.cos(theta) * rr, y, z: Math.sin(theta) * rr };
  };
  // Extra moons (ice/rocky only — "gas moon" or "terrestrial moon" don't read as sensible).
  // Default 1-2; palette.moonCount overrides the count while still consuming the RNG draw.
  const moonRoll = 1 + ((rng() * 2) | 0);
  const moonN = palette.moonCount != null ? Math.max(0, palette.moonCount | 0) : moonRoll;
  for (let i = 0; i < moonN; i++) {
    const r = radius * (0.7 + rng() * 0.08);
    const kind = weightedPick(rng, MOON_KINDS, MOON_WEIGHTS);
    out.push({ type: 'moon', companion: false, kind, detail: 'low', gas: kind === 'gas',
      position: place(dir(), r), radius: r,
      size: radius * (0.018 + rng() * 0.02) * bodyScale, color: randomKindColor(rng, kind), color2: randomKindColor(rng, kind),
      phase: rng(), seed: rng() });
  }
  // Small distant planets. Default 2-4; palette.planetCount overrides (RNG draw still consumed).
  const distRoll = 2 + ((rng() * 3) | 0);
  const distN = palette.planetCount != null ? Math.max(0, palette.planetCount | 0) : distRoll;
  for (let i = 0; i < distN; i++) {
    const r = radius * (0.72 + rng() * 0.06);
    const kind = weightedPick(rng, PLANET_KINDS, KIND_WEIGHTS);
    out.push({ type: 'planet', scaleClass: 'distant', kind, detail: 'low', gas: kind === 'gas',
      position: place(dir(), r), radius: r,
      size: radius * (0.01 + rng() * 0.015) * bodyScale, color: randomKindColor(rng, kind), color2: randomKindColor(rng, kind),
      rings: false, glow: rng() < 0.3, glowRadius: 1.15 + rng() * 0.35, glowIntensity: 0.35 + rng() * 0.3,
      seed: rng() });
  }
  // Exactly one large near planet.
  const nearDir = dir();
  const nearR = radius * 0.6;
  const nearSize = radius * (0.06 + rng() * 0.04) * bodyScale;
  const nearKind = weightedPick(rng, PLANET_KINDS, KIND_WEIGHTS);
  const near = { type: 'planet', scaleClass: 'near', kind: nearKind, detail: 'high', gas: nearKind === 'gas',
    position: place(nearDir, nearR), radius: nearR,
    size: nearSize, color: randomKindColor(rng, nearKind), color2: randomKindColor(rng, nearKind),
    rings: rng() < 0.4,
    // Full rotation range, not a narrow band — an earlier version only ever rolled -0.8 to
    // -0.3 rad (~46-17 degrees), so every generated ring looked like a shallow variant of the
    // same tilt.
    ringTilt: rng() * Math.PI * 2 - Math.PI, ringInner: 1.25 + rng() * 0.15, ringOuter: 1.6 + rng() * 0.3,
    ringBandCount: 3 + ((rng() * 4) | 0), ringDensity: 0.7 + rng() * 0.6,
    glow: true, glowRadius: 1.2 + rng() * 0.35, glowIntensity: 0.4 + rng() * 0.3,
    seed: rng() };
  out.push(near);
  // 1-3 companion moons orbiting the near planet (offset around its screen position).
  const compN = 1 + ((rng() * 3) | 0);
  for (let i = 0; i < compN; i++) {
    const d = { x: nearDir.x + (rng() * 2 - 1) * 0.06, y: nearDir.y + (rng() * 2 - 1) * 0.06,
      z: nearDir.z + (rng() * 2 - 1) * 0.06 };
    const kind = weightedPick(rng, MOON_KINDS, MOON_WEIGHTS);
    out.push({ type: 'moon', companion: true, kind, detail: 'high', gas: kind === 'gas',
      position: place(d, nearR), radius: nearR,
      size: nearSize * (0.12 + rng() * 0.1), color: randomKindColor(rng, kind), color2: randomKindColor(rng, kind),
      phase: rng(), seed: rng() });
  }
  return out;
}
