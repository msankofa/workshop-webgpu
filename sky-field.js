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
  const bandCount = Math.round((palette.starCount || 1400) * 1.1);
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

const PLANET_COLORS = ['#b07a55', '#7d8aa0', '#c9a06a', '#6a8f7d', '#9a6b8c', '#5f7bbf'];

// Extra moons + distant/near planets + the near planet's companion moons. Each body is a
// plain descriptor (type, world position on its own radius, size, color, flags) the TSL
// celestial-bodies module turns into a sprite. Night/dusk only (caller gates on palette).
export function generateCelestialBodies(radius, palette, rng) {
  const out = [];
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
  const pick = arr => arr[(rng() * arr.length) | 0];

  // 1-2 extra moons.
  const moonN = 1 + ((rng() * 2) | 0);
  for (let i = 0; i < moonN; i++) {
    const r = radius * (0.7 + rng() * 0.08);
    out.push({ type: 'moon', companion: false, position: place(dir(), r), radius: r,
      size: radius * (0.018 + rng() * 0.02), color: '#d7dcea', phase: rng() });
  }
  // 2-4 small distant planets.
  const distN = 2 + ((rng() * 3) | 0);
  for (let i = 0; i < distN; i++) {
    const r = radius * (0.72 + rng() * 0.06);
    out.push({ type: 'planet', scaleClass: 'distant', position: place(dir(), r), radius: r,
      size: radius * (0.01 + rng() * 0.015), color: pick(PLANET_COLORS),
      gas: rng() < 0.5, rings: false, glow: rng() < 0.3 });
  }
  // Exactly one large near planet.
  const nearDir = dir();
  const nearR = radius * 0.6;
  const nearSize = radius * (0.06 + rng() * 0.04);
  const near = { type: 'planet', scaleClass: 'near', position: place(nearDir, nearR), radius: nearR,
    size: nearSize, color: pick(PLANET_COLORS), gas: rng() < 0.6, rings: rng() < 0.4, glow: true };
  out.push(near);
  // 1-3 companion moons orbiting the near planet (offset around its screen position).
  const compN = 1 + ((rng() * 3) | 0);
  for (let i = 0; i < compN; i++) {
    const d = { x: nearDir.x + (rng() * 2 - 1) * 0.06, y: nearDir.y + (rng() * 2 - 1) * 0.06,
      z: nearDir.z + (rng() * 2 - 1) * 0.06 };
    out.push({ type: 'moon', companion: true, position: place(d, nearR), radius: nearR,
      size: nearSize * (0.12 + rng() * 0.1), color: '#cdd3e0', phase: rng() });
  }
  return out;
}
