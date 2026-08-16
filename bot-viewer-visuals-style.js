// bot-viewer-visuals-style.js — pure look data for the bot viewer's visual system.
// No Three.js: themes, palette math and the procedural theme generator all live here so they
// stay Node-testable (test-bot-viewer-visuals.mjs). The renderer half is bot-viewer-visuals.js.
// Same split as shoot-house-style.js / shoot-house.js.

// ─── colour helpers ─────────────────────────────────────────────────────────

export function hexToRgb(hex) {
  return { r: ((hex >> 16) & 255) / 255, g: ((hex >> 8) & 255) / 255, b: (hex & 255) / 255 };
}

export function rgbToHex(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return (c(r) << 16) | (c(g) << 8) | c(b);
}

export function lerpHex(a, b, t) {
  const x = hexToRgb(a), y = hexToRgb(b);
  return rgbToHex(x.r + (y.r - x.r) * t, x.g + (y.g - x.g) * t, x.b + (y.b - x.b) * t);
}

// Scales a colour toward black (m<1) or white (m>1) without changing its hue.
export function shadeHex(hex, m) {
  return m <= 1 ? lerpHex(0x000000, hex, m) : lerpHex(hex, 0xffffff, Math.min(1, m - 1));
}

// Rec.709 relative luminance of a packed hex, in [0,1].
export function luma(hex) {
  const c = hexToRgb(hex);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

// h in [0,1) turns, s/l in [0,1].
export function hslHex(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(Math.min(k - 3, 9 - k), 1));
  };
  return rgbToHex(f(0), f(8), f(4));
}

// Inverse of hslHex. h in [0,1) turns; a grey returns h = 0.
export function hexToHsl(hex) {
  const { r, g, b } = hexToRgb(hex);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: ((h / 6) % 1 + 1) % 1, s, l };
}

// Rotates a colour around the hue wheel by `turns`, keeping saturation and lightness. Drives the
// cycling muzzle-flash tint: each shot samples the wheel at its own moment, so a full-auto burst
// paints a gradient rather than every round in the burst firing the same colour.
export function cycleHueHex(hex, turns) {
  if (!turns) return hex;
  const { h, s, l } = hexToHsl(hex);
  return hslHex(((h + turns) % 1 + 1) % 1, s, l);
}

// mulberry32, same generator the maze uses — a seed reproduces a look exactly.
export function makeRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── theme shape ────────────────────────────────────────────────────────────
// A theme is one complete look: background/sky, fog, the light rig, the three map materials
// and the post stack. Every field is required — createVisualSystem reads them without
// defaulting, and validateTheme() below is what the Node test asserts against.

export const THEME_SECTIONS = ['bg', 'fog', 'sky', 'lights', 'mats', 'bots', 'post', 'env'];

// Toggles a theme may switch off by default. The panel can override any of them live; a theme
// only states where it starts.
export const DEFAULT_TOGGLES = {
  sky: true, stars: true, nebula: true, planet: false, sunGlow: true,
  fog: true, grid: true, trim: true, pulse: true, rim: true, scan: false,
  reflections: false, shadows: true,
  // Weathering and growth. Both are off on every theme but ecobrutal, which is the only one
  // whose surfaces are meant to read as aged concrete rather than clean panel.
  concrete: true, flora: true,
  // bots: the map is self-lit, so bots need their own emission or they vanish in the dark themes
  botGlow: true, botRim: true, groundPools: true, dynamicLights: true, flashlights: false,
  // Off = physically-warm propellant flashes. On = the theme's flashTintColor drives every dynamic
  // flash instead, optionally rotating through the hue wheel. Purely a toy; default off.
  flashTint: false,
};

function theme(t) { return t; }

// ─── concrete weathering (optional per-surface block) ───────────────────────
// `mats.wall.concrete` / `mats.cover.concrete` turn a flat colour uniform into cast concrete:
// a form-panel grid with recessed joints and tie holes, horizontal board grain, exposed
// aggregate, rain streaking off the top edge, and growth. Left out of THEME_SECTIONS and
// REQUIRED on purpose -- it is an OPTIONAL block, read as `w.concrete ?? CONCRETE_OFF`, so
// the six pre-existing themes need no edit and render byte-identically.
export const CONCRETE_OFF = {
  gain: 0,                                  // master mix; 0 = the flat themed colour, untouched
  panelW: 2.4, panelH: 1.8,                 // form-panel cell size in metres
  seamWidth: 0.018, seamDark: 0.4,          // recessed joint between panels
  boardPitch: 0.22, boardWidth: 0.01,       // horizontal board-form grain
  boardGain: 0, boardToneVar: 0.06,         // each board pours a slightly different shade
  tieGain: 0, tieRadius: 0.032,             // form-tie holes
  tieH: 1.2, tieV: 0.9,                     // tie-hole spacing in metres
  grainGain: 0, mottleGain: 0,              // exposed aggregate speckle / patina blotching
  stainColor: 0x4d5150, stainGain: 0, stainLength: 0.5,   // rain streaks off the top edge
  mossColor: 0x4a6b32, mossGain: 0,         // moss on up-facing surfaces (shared mossWeight law)
  algaeGain: 0, algaeHeight: 0.28,          // damp green creeping up the base of a vertical face
};

// ─── flora (optional per-theme block) ───────────────────────────────────────
// What bot-flora.js grows on a layout. Same optional-block convention as CONCRETE_OFF:
// absent means a bare map, so only ecobrutal ships a populated one.
export const FLORA_OFF = {
  grassDensity: 0,                          // blades per m^2 of open ground
  grassHeight: 0.42, grassHeightVar: 0.34,
  grassBase: 0x24361a, grassTip: 0x6f9440,
  grassStyle: 'mottle',                     // one of grass-textures.js's STYLE_KEYS
  // Hard ceiling on the merged blade mesh. Measured on a 900-wall 200 m map: ~40 ms rebuild at
  // 240k, ~100 ms at 720k, ~170 ms at 1.2M, scaling linearly; buffers are ~176 bytes a blade.
  // Build time is the real constraint, not memory. Above this the field thins instead of growing.
  bladeCap: 720000,
  wind: 0.7,
  // Understory plants (plants-placement.js). plantDensity is the density AT A WALL, not the
  // average: plantReach/plantOpenFloor mask it down to plantOpenFloor out in the open, because
  // every reference photograph has the understory massed against the concrete.
  plantDensity: 0, plantReach: 1.8, plantOpenFloor: 0.25, plantClumpRadius: 1.2,
  // Per-species multipliers, keyed by PLANT_PRESETS key. Absent = 1. Height rebakes the palette
  // geometry; density reweights species selection, so only height costs a rebuild.
  speciesHeight: {}, speciesDensity: {},
  vineDensity: 0, vineLength: 1.5,          // strands per metre of wall top edge
  vineClump: 0.35,                          // 0 = evenly spaced along an edge, 1 = tight bunches
  vineLeafiness: 1, vineBranch: 0.3,        // leaf cards per strand; chance a strand forks
  clearance: 0.35,                          // m of bare ground kept around walls and cover
  grassLook: {},                            // grass-look.js overrides (windDir/curl/translucency/rootShade/coverage); absent = off
};

export const THEMES = {

  // ---- the baseline: the viewer's original neutral grey box, cleaned up ----
  hangar: theme({
    key: 'hangar', label: 'Hangar (neutral)',
    toggles: { sky: false, nebula: false, grid: false, trim: false, pulse: false, rim: false },
    bg: 0x14171c,
    fog: { color: 0x14171c, density: 0.006 },
    sky: {
      horizon: 0x1b2029, zenith: 0x0c0f14, groundTint: 0x0a0c10,
      nebulaA: 0x243044, nebulaB: 0x3a4358, nebulaGain: 0.25, nebulaScale: 2.4, nebulaTilt: 0.5,
      starGain: 0.5, starDensity: 1.0, starTwinkle: 0.5, starWrap: 0.6,
      sunColor: 0xfff3dc, sunGain: 0.5, sunSize: 0.02,
      planet: { color: 0x5a6472, atmo: 0x8fb6ff, size: 0.10, azimuth: 210, elevation: 22, bands: 0.3 },
    },
    lights: {
      key: { color: 0xfff4e0, intensity: 1.8, azimuth: 20, elevation: 60 },
      ambient: { color: 0x8ab4e8, intensity: 0.6 },
      overhead: { color: 0xffffff, intensity: 28, distance: 22, height: 8 },
      rim: { color: 0x9ec8ff, intensity: 0.0, azimuth: 200, elevation: 18 },
      accents: { colorA: 0x4fc3f7, colorB: 0xff7043, intensity: 0, height: 2.4, radius: 14 },
    },
    mats: {
      floor: {
        color: 0x2a2f37, roughness: 1.0, metalness: 0.0, reflectMetalness: 0.35, reflectRoughness: 0.35,
        gridColor: 0x4fc3f7, gridPitch: 3, gridWidth: 0.05, gridGain: 0.0, gridFade: 60,
        vignette: 0.25, scanColor: 0x4fc3f7, scanGain: 0.0, scanPeriod: 6, scanSpeed: 9, scanWidth: 1.2,
      },
      wall: {
        color: 0x3d4450, roughness: 0.9, metalness: 0.0,
        trimColor: 0x6f7d92, trimGain: 0.0, trimTop: 0.94, trimBottom: 0.05, trimWidth: 0.03,
        pulseGain: 0.0, pulseSpeed: 1.2, pulseScale: 0.16,
        rimColor: 0x9ec8ff, rimGain: 0.0, rimPower: 3.0,
      },
      cover: {
        color: 0x6b5836, roughness: 0.85, metalness: 0.0,
        stripeColor: 0xffb020, stripeGain: 0.0, stripePitch: 0.5, capColor: 0xffb020, capGain: 0.0,
      },
    },
    bots: {
      shellGlow: 0.35, plateGlow: 0.10, trimGlow: 0.20, eyeGlow: 0.8, eyeColor: 0x9ec8ff,
      rimColor: 0x9ec8ff, rimGain: 0.25, rimPower: 3.0,
      poolGain: 0.25, poolRadius: 0.75,
      flashTintColor: 0x4fc3f7, flashTintCycle: 0,
      flashColor: 0xffe6bd, flashIntensity: 26, flashDistance: 10, flashLife: 0.06,
      beamColor: 0xdff0ff, beamGain: 0.14, beamLength: 9, beamAngle: 16, beamIntensity: 22,
    },
    post: {
      tone: 'agx', exposure: 1.0,
      bloom: { strength: 0.10, radius: 0.7, threshold: 0.85 },
      grade: { contrast: 1.05, saturation: 1.1, gamma: 1.0, temperature: 0.0, tint: 0.0, vignette: 0.18, vignetteSoft: 1.0 },
    },
    env: { intensity: 0.35 },
  }),

  // ---- the shoot-house look, pushed further: black deck, glowing grid, cyan/magenta trim ----
  internetcore: theme({
    key: 'internetcore', label: 'Internetcore (neon)',
    toggles: { sky: true, stars: true, nebula: true, planet: false, scan: true },
    bg: 0x08090f,
    fog: { color: 0x0a0c16, density: 0.016 },
    sky: {
      horizon: 0x1b0f3a, zenith: 0x05060e, groundTint: 0x06070d,
      nebulaA: 0x39f0ff, nebulaB: 0xff3df0, nebulaGain: 0.45, nebulaScale: 2.9, nebulaTilt: 0.7,
      starGain: 1.0, starDensity: 1.3, starTwinkle: 1.0, starWrap: 1.0,
      sunColor: 0x8b5cff, sunGain: 0.30, sunSize: 0.03,
      planet: { color: 0x2a1a4a, atmo: 0xff3df0, size: 0.16, azimuth: 250, elevation: 16, bands: 0.6 },
    },
    lights: {
      key: { color: 0xbfd8ff, intensity: 0.9, azimuth: 35, elevation: 55 },
      ambient: { color: 0x3a2f6a, intensity: 0.5 },
      overhead: { color: 0x39f0ff, intensity: 18, distance: 26, height: 7 },
      rim: { color: 0xff3df0, intensity: 0.9, azimuth: 215, elevation: 12 },
      accents: { colorA: 0x39f0ff, colorB: 0xff3df0, intensity: 26, height: 2.6, radius: 16 },
    },
    mats: {
      floor: {
        color: 0x0c0e16, roughness: 0.5, metalness: 0.1, reflectMetalness: 0.75, reflectRoughness: 0.16,
        gridColor: 0x39f0ff, gridPitch: 2.5, gridWidth: 0.055, gridGain: 1.7, gridFade: 70,
        vignette: 0.45, scanColor: 0xff3df0, scanGain: 1.6, scanPeriod: 7, scanSpeed: 11, scanWidth: 1.1,
      },
      wall: {
        color: 0x141826, roughness: 0.55, metalness: 0.1,
        trimColor: 0x39f0ff, trimGain: 1.6, trimTop: 0.95, trimBottom: 0.04, trimWidth: 0.025,
        pulseGain: 1.4, pulseSpeed: 1.6, pulseScale: 0.13,
        rimColor: 0xff3df0, rimGain: 0.30, rimPower: 3.5,
      },
      cover: {
        color: 0x161b2b, roughness: 0.45, metalness: 0.1,
        stripeColor: 0xffb020, stripeGain: 1.1, stripePitch: 0.42, capColor: 0x39f0ff, capGain: 1.7,
      },
    },
    bots: {
      shellGlow: 1.60, plateGlow: 0.40, trimGlow: 0.80, eyeGlow: 2.0, eyeColor: 0xff3df0,
      rimColor: 0x39f0ff, rimGain: 0.70, rimPower: 2.8,
      poolGain: 0.55, poolRadius: 0.80,
      flashTintColor: 0x39f0ff, flashTintCycle: 0,
      flashColor: 0xffd9a0, flashIntensity: 34, flashDistance: 12, flashLife: 0.07,
      beamColor: 0x8ff4ff, beamGain: 0.22, beamLength: 10, beamAngle: 17, beamIntensity: 30,
    },
    post: {
      tone: 'agx', exposure: 1.15,
      bloom: { strength: 0.45, radius: 0.85, threshold: 0.5 },
      grade: { contrast: 1.16, saturation: 1.35, gamma: 1.0, temperature: -0.05, tint: 0.04, vignette: 0.42, vignetteSoft: 0.9 },
    },
    env: { intensity: 0.9 },
  }),

  // ---- CQB deck of an orbiting station: real starfield + planet outside, warm interior ----
  orbital: theme({
    key: 'orbital', label: 'Orbital (space)',
    toggles: { sky: true, stars: true, nebula: true, planet: true, scan: false },
    bg: 0x03040a,
    fog: { color: 0x070a14, density: 0.010 },
    sky: {
      horizon: 0x0a1024, zenith: 0x02030a, groundTint: 0x02030a,
      nebulaA: 0x2b6fff, nebulaB: 0xff8a4c, nebulaGain: 0.40, nebulaScale: 2.2, nebulaTilt: 0.35,
      starGain: 1.35, starDensity: 2.4, starTwinkle: 0.7, starWrap: 1.0,
      sunColor: 0xfff2d0, sunGain: 1.4, sunSize: 0.015,
      planet: { color: 0x3f6ea8, atmo: 0x9fd0ff, size: 0.42, azimuth: 245, elevation: 8, bands: 0.75 },
    },
    lights: {
      key: { color: 0xffffff, intensity: 2.4, azimuth: 65, elevation: 22 },
      ambient: { color: 0x2b4a7a, intensity: 0.35 },
      overhead: { color: 0xffe0b0, intensity: 24, distance: 24, height: 7.5 },
      rim: { color: 0x6fa8ff, intensity: 1.2, azimuth: 245, elevation: 8 },
      accents: { colorA: 0xffb347, colorB: 0x4fc3f7, intensity: 12, height: 2.5, radius: 16 },
    },
    mats: {
      floor: {
        color: 0x1a1d24, roughness: 0.55, metalness: 0.25, reflectMetalness: 0.8, reflectRoughness: 0.12,
        gridColor: 0x7fb4ff, gridPitch: 3, gridWidth: 0.05, gridGain: 0.9, gridFade: 90,
        vignette: 0.30, scanColor: 0x7fb4ff, scanGain: 0.0, scanPeriod: 8, scanSpeed: 10, scanWidth: 1.4,
      },
      wall: {
        color: 0x555b66, roughness: 0.65, metalness: 0.35,
        trimColor: 0xffb347, trimGain: 1.5, trimTop: 0.90, trimBottom: 0.06, trimWidth: 0.028,
        pulseGain: 0.5, pulseSpeed: 0.7, pulseScale: 0.10,
        rimColor: 0x9fd0ff, rimGain: 0.35, rimPower: 4.0,
      },
      cover: {
        color: 0x3a4048, roughness: 0.6, metalness: 0.3,
        stripeColor: 0xffb347, stripeGain: 1.0, stripePitch: 0.45, capColor: 0xffd28a, capGain: 1.2,
      },
    },
    bots: {
      shellGlow: 1.00, plateGlow: 0.25, trimGlow: 0.50, eyeGlow: 1.4, eyeColor: 0xffb347,
      rimColor: 0x9fd0ff, rimGain: 0.55, rimPower: 3.2,
      poolGain: 0.40, poolRadius: 0.80,
      flashTintColor: 0xffb347, flashTintCycle: 0,
      flashColor: 0xffe0b0, flashIntensity: 30, flashDistance: 12, flashLife: 0.06,
      beamColor: 0xdfeeff, beamGain: 0.18, beamLength: 11, beamAngle: 15, beamIntensity: 34,
    },
    post: {
      tone: 'aces', exposure: 1.05,
      bloom: { strength: 0.45, radius: 0.8, threshold: 0.6 },
      grade: { contrast: 1.12, saturation: 1.05, gamma: 1.0, temperature: -0.06, tint: 0.0, vignette: 0.34, vignetteSoft: 1.0 },
    },
    env: { intensity: 1.0 },
  }),

  // ---- emergency lighting: red/amber, thick haze, almost no key ----
  blacksite: theme({
    key: 'blacksite', label: 'Blacksite (alarm)',
    toggles: { sky: false, stars: false, nebula: false, planet: false, scan: true },
    bg: 0x0d0605,
    fog: { color: 0x1a0806, density: 0.045 },
    sky: {
      horizon: 0x2a0c06, zenith: 0x080304, groundTint: 0x060202,
      nebulaA: 0xff3b30, nebulaB: 0xffb020, nebulaGain: 0.3, nebulaScale: 3.2, nebulaTilt: 0.2,
      starGain: 0.2, starDensity: 0.6, starTwinkle: 1.4, starWrap: 0.0,
      sunColor: 0xff5a3c, sunGain: 0.4, sunSize: 0.03,
      planet: { color: 0x3a1208, atmo: 0xff6a3a, size: 0.2, azimuth: 130, elevation: 6, bands: 0.5 },
    },
    lights: {
      key: { color: 0xff8a5c, intensity: 0.45, azimuth: 140, elevation: 35 },
      ambient: { color: 0x40120c, intensity: 0.55 },
      overhead: { color: 0xff3b30, intensity: 22, distance: 18, height: 6 },
      rim: { color: 0xffb020, intensity: 0.8, azimuth: 320, elevation: 14 },
      accents: { colorA: 0xff3b30, colorB: 0xffb020, intensity: 30, height: 2.2, radius: 12 },
    },
    mats: {
      floor: {
        color: 0x14100e, roughness: 0.75, metalness: 0.05, reflectMetalness: 0.6, reflectRoughness: 0.25,
        gridColor: 0xff5a3c, gridPitch: 2.5, gridWidth: 0.055, gridGain: 0.8, gridFade: 45,
        vignette: 0.55, scanColor: 0xff3b30, scanGain: 2.6, scanPeriod: 4, scanSpeed: 14, scanWidth: 0.9,
      },
      wall: {
        color: 0x2a2320, roughness: 0.85, metalness: 0.05,
        trimColor: 0xff3b30, trimGain: 2.0, trimTop: 0.88, trimBottom: 0.05, trimWidth: 0.04,
        pulseGain: 2.4, pulseSpeed: 2.6, pulseScale: 0.09,
        rimColor: 0xffb020, rimGain: 0.30, rimPower: 3.0,
      },
      cover: {
        color: 0x2e1f14, roughness: 0.8, metalness: 0.05,
        stripeColor: 0xffb020, stripeGain: 2.0, stripePitch: 0.35, capColor: 0xff3b30, capGain: 1.8,
      },
    },
    // Almost no key light here, so the bots carry their own: hot emissive plates, a strong amber
    // rim and the brightest flashlight in the set. This is the theme flashlights exist for.
    bots: {
      shellGlow: 2.00, plateGlow: 0.50, trimGlow: 1.00, eyeGlow: 2.2, eyeColor: 0xff3b30,
      rimColor: 0xffb020, rimGain: 0.80, rimPower: 2.6,
      poolGain: 0.70, poolRadius: 0.85,
      flashTintColor: 0xff3b30, flashTintCycle: 0,
      flashColor: 0xffd0a0, flashIntensity: 42, flashDistance: 14, flashLife: 0.08,
      beamColor: 0xffe0c0, beamGain: 0.28, beamLength: 12, beamAngle: 18, beamIntensity: 40,
    },
    post: {
      tone: 'aces', exposure: 1.2,
      bloom: { strength: 0.6, radius: 0.9, threshold: 0.45 },
      grade: { contrast: 1.22, saturation: 1.25, gamma: 1.0, temperature: 0.10, tint: -0.02, vignette: 0.55, vignetteSoft: 0.85 },
    },
    env: { intensity: 0.45 },
  }),

  // ---- flat bright daylight: the readable one, for actually watching bot behaviour ----
  daybreak: theme({
    key: 'daybreak', label: 'Daybreak (readable)',
    toggles: { sky: true, stars: false, nebula: false, planet: false, fog: true, trim: false, pulse: false, grid: false, rim: false, scan: false },
    bg: 0x9fc4e8,
    fog: { color: 0xb8d2ea, density: 0.004 },
    sky: {
      horizon: 0xd9e9f7, zenith: 0x4d8bd4, groundTint: 0x6f7f8c,
      nebulaA: 0xffffff, nebulaB: 0xdfe9f5, nebulaGain: 0.12, nebulaScale: 2.0, nebulaTilt: 0.1,
      starGain: 0.0, starDensity: 0.4, starTwinkle: 0.3, starWrap: 0.0,
      sunColor: 0xfff6e0, sunGain: 1.6, sunSize: 0.012,
      planet: { color: 0xc8d4e0, atmo: 0xffffff, size: 0.08, azimuth: 300, elevation: 30, bands: 0.2 },
    },
    lights: {
      key: { color: 0xfff2dc, intensity: 3.0, azimuth: 35, elevation: 58 },
      ambient: { color: 0x9dc0e8, intensity: 1.1 },
      overhead: { color: 0xffffff, intensity: 6, distance: 20, height: 8 },
      rim: { color: 0xcfe4ff, intensity: 0.4, azimuth: 215, elevation: 20 },
      accents: { colorA: 0xffffff, colorB: 0xffffff, intensity: 0, height: 2.4, radius: 14 },
    },
    mats: {
      floor: {
        color: 0x6d7a72, roughness: 0.95, metalness: 0.0, reflectMetalness: 0.15, reflectRoughness: 0.6,
        gridColor: 0xffffff, gridPitch: 3, gridWidth: 0.05, gridGain: 0.0, gridFade: 80,
        vignette: 0.12, scanColor: 0xffffff, scanGain: 0.0, scanPeriod: 6, scanSpeed: 9, scanWidth: 1.2,
      },
      wall: {
        color: 0x9aa2a8, roughness: 0.9, metalness: 0.0,
        trimColor: 0xd8dde2, trimGain: 0.0, trimTop: 0.94, trimBottom: 0.05, trimWidth: 0.03,
        pulseGain: 0.0, pulseSpeed: 1.0, pulseScale: 0.14,
        rimColor: 0xffffff, rimGain: 0.0, rimPower: 3.0,
      },
      cover: {
        color: 0x8a7a52, roughness: 0.9, metalness: 0.0,
        stripeColor: 0xffffff, stripeGain: 0.0, stripePitch: 0.5, capColor: 0xffffff, capGain: 0.0,
      },
    },
    // Real daylight already reads the bots; emission and additive ground pools would only wash
    // them out, so this theme keeps them essentially off.
    bots: {
      shellGlow: 0.06, plateGlow: 0.02, trimGlow: 0.05, eyeGlow: 0.4, eyeColor: 0xffffff,
      rimColor: 0xffffff, rimGain: 0.0, rimPower: 3.0,
      poolGain: 0.0, poolRadius: 0.75,
      flashTintColor: 0x4fc3f7, flashTintCycle: 0,
      flashColor: 0xfff2d0, flashIntensity: 18, flashDistance: 8, flashLife: 0.05,
      beamColor: 0xffffff, beamGain: 0.05, beamLength: 7, beamAngle: 14, beamIntensity: 10,
    },
    post: {
      tone: 'agx', exposure: 1.0,
      bloom: { strength: 0.08, radius: 0.6, threshold: 0.9 },
      grade: { contrast: 1.02, saturation: 1.0, gamma: 1.0, temperature: 0.0, tint: 0.0, vignette: 0.10, vignetteSoft: 1.2 },
    },
    env: { intensity: 0.8 },
  }),

  // ---- high-contrast monochrome: geometry and silhouettes only ----
  noir: theme({
    key: 'noir', label: 'Noir (mono)',
    toggles: { sky: true, stars: true, nebula: false, planet: false, scan: false },
    bg: 0x000000,
    fog: { color: 0x090909, density: 0.024 },
    sky: {
      horizon: 0x141414, zenith: 0x000000, groundTint: 0x000000,
      nebulaA: 0x2a2a2a, nebulaB: 0x3c3c3c, nebulaGain: 0.2, nebulaScale: 2.5, nebulaTilt: 0.4,
      starGain: 0.9, starDensity: 1.1, starTwinkle: 0.8, starWrap: 1.0,
      sunColor: 0xffffff, sunGain: 1.0, sunSize: 0.02,
      planet: { color: 0x1a1a1a, atmo: 0xffffff, size: 0.18, azimuth: 210, elevation: 14, bands: 0.4 },
    },
    lights: {
      key: { color: 0xffffff, intensity: 3.4, azimuth: 55, elevation: 30 },
      ambient: { color: 0x101010, intensity: 0.25 },
      overhead: { color: 0xffffff, intensity: 16, distance: 20, height: 7 },
      rim: { color: 0xffffff, intensity: 1.8, azimuth: 235, elevation: 10 },
      accents: { colorA: 0xffffff, colorB: 0xffffff, intensity: 6, height: 2.6, radius: 15 },
    },
    mats: {
      floor: {
        color: 0x0b0b0b, roughness: 0.6, metalness: 0.1, reflectMetalness: 0.7, reflectRoughness: 0.2,
        gridColor: 0xffffff, gridPitch: 3, gridWidth: 0.05, gridGain: 0.7, gridFade: 60,
        vignette: 0.6, scanColor: 0xffffff, scanGain: 0.0, scanPeriod: 6, scanSpeed: 9, scanWidth: 1.2,
      },
      wall: {
        color: 0x1e1e1e, roughness: 0.7, metalness: 0.05,
        trimColor: 0xffffff, trimGain: 1.4, trimTop: 0.96, trimBottom: 0.03, trimWidth: 0.02,
        pulseGain: 0.0, pulseSpeed: 1.0, pulseScale: 0.12,
        rimColor: 0xffffff, rimGain: 0.55, rimPower: 2.6,
      },
      cover: {
        color: 0x161616, roughness: 0.7, metalness: 0.05,
        stripeColor: 0xffffff, stripeGain: 0.9, stripePitch: 0.4, capColor: 0xffffff, capGain: 1.4,
      },
    },
    bots: {
      shellGlow: 1.20, plateGlow: 0.30, trimGlow: 0.60, eyeGlow: 1.6, eyeColor: 0xffffff,
      rimColor: 0xffffff, rimGain: 1.00, rimPower: 2.4,
      poolGain: 0.35, poolRadius: 0.80,
      flashTintColor: 0xff3b6b, flashTintCycle: 0,
      flashColor: 0xffeccd, flashIntensity: 36, flashDistance: 12, flashLife: 0.07,
      beamColor: 0xffffff, beamGain: 0.20, beamLength: 11, beamAngle: 16, beamIntensity: 32,
    },
    post: {
      tone: 'reinhard', exposure: 1.1,
      bloom: { strength: 0.35, radius: 0.9, threshold: 0.55 },
      grade: { contrast: 1.45, saturation: 0.0, gamma: 0.95, temperature: 0.0, tint: 0.0, vignette: 0.62, vignetteSoft: 0.8 },
    },
    env: { intensity: 0.5 },
  }),

  // ---- irradiated green: sickly haze, lime trim ----
  toxic: theme({
    key: 'toxic', label: 'Toxic (green haze)',
    toggles: { sky: true, stars: true, nebula: true, planet: true, scan: true },
    bg: 0x060c07,
    fog: { color: 0x0c1a0e, density: 0.038 },
    sky: {
      horizon: 0x122a14, zenith: 0x040806, groundTint: 0x050a06,
      nebulaA: 0x7dff5a, nebulaB: 0x18a06a, nebulaGain: 0.5, nebulaScale: 3.0, nebulaTilt: 0.6,
      starGain: 0.8, starDensity: 1.1, starTwinkle: 1.2, starWrap: 0.85,
      sunColor: 0xb8ff7a, sunGain: 0.9, sunSize: 0.035,
      planet: { color: 0x1e5a34, atmo: 0x9dff8a, size: 0.26, azimuth: 195, elevation: 12, bands: 0.7 },
    },
    lights: {
      key: { color: 0xcaf7a8, intensity: 1.1, azimuth: 195, elevation: 40 },
      ambient: { color: 0x1f4a2c, intensity: 0.6 },
      overhead: { color: 0x9dff8a, intensity: 20, distance: 20, height: 7 },
      rim: { color: 0x7dff5a, intensity: 0.9, azimuth: 15, elevation: 16 },
      accents: { colorA: 0x7dff5a, colorB: 0xffe14c, intensity: 20, height: 2.4, radius: 14 },
    },
    mats: {
      floor: {
        color: 0x101a12, roughness: 0.65, metalness: 0.08, reflectMetalness: 0.6, reflectRoughness: 0.22,
        gridColor: 0x7dff5a, gridPitch: 2.5, gridWidth: 0.055, gridGain: 1.6, gridFade: 55,
        vignette: 0.48, scanColor: 0xffe14c, scanGain: 1.8, scanPeriod: 5, scanSpeed: 10, scanWidth: 1.0,
      },
      wall: {
        color: 0x1d2a1f, roughness: 0.75, metalness: 0.08,
        trimColor: 0x7dff5a, trimGain: 2.0, trimTop: 0.92, trimBottom: 0.05, trimWidth: 0.03,
        pulseGain: 1.2, pulseSpeed: 1.1, pulseScale: 0.12,
        rimColor: 0xb8ff7a, rimGain: 0.30, rimPower: 3.2,
      },
      cover: {
        color: 0x24301f, roughness: 0.8, metalness: 0.08,
        stripeColor: 0xffe14c, stripeGain: 1.6, stripePitch: 0.4, capColor: 0x7dff5a, capGain: 1.8,
      },
    },
    bots: {
      shellGlow: 1.40, plateGlow: 0.35, trimGlow: 0.70, eyeGlow: 1.8, eyeColor: 0x7dff5a,
      rimColor: 0x7dff5a, rimGain: 0.65, rimPower: 3.0,
      poolGain: 0.50, poolRadius: 0.80,
      flashTintColor: 0x7dff5a, flashTintCycle: 0,
      flashColor: 0xffe2a8, flashIntensity: 32, flashDistance: 12, flashLife: 0.07,
      beamColor: 0xb8ff7a, beamGain: 0.22, beamLength: 10, beamAngle: 17, beamIntensity: 30,
    },
    post: {
      tone: 'agx', exposure: 1.1,
      bloom: { strength: 0.55, radius: 0.85, threshold: 0.45 },
      grade: { contrast: 1.18, saturation: 1.2, gamma: 1.0, temperature: -0.02, tint: 0.08, vignette: 0.5, vignetteSoft: 0.9 },
    },
    env: { intensity: 0.6 },
  }),

  // ---- eco-brutalism: cast concrete going back to the ground ----
  // The only theme with no neon at all -- every trim/grid/scan/pulse gain is zero and the
  // surface interest comes from the concrete block below instead. Real sun with sharp shadows
  // rather than overcast: it matches the reference set (references/eco-brutalism) and, like
  // daybreak, it is a theme you can actually read bot behaviour in.
  ecobrutal: theme({
    key: 'ecobrutal', label: 'Eco-brutalism (concrete + growth)',
    toggles: {
      sky: true, stars: false, nebula: false, planet: false, fog: true,
      grid: false, trim: false, pulse: false, rim: false, scan: false,
      concrete: true, flora: true,
    },
    bg: 0x8fb4d8,
    fog: { color: 0xb4c6d2, density: 0.005 },
    sky: {
      horizon: 0xcfe0ee, zenith: 0x4f8ac9, groundTint: 0x5a6350,
      nebulaA: 0xffffff, nebulaB: 0xe4ecf2, nebulaGain: 0.08, nebulaScale: 2.0, nebulaTilt: 0.1,
      starGain: 0.0, starDensity: 0.4, starTwinkle: 0.3, starWrap: 0.0,
      sunColor: 0xfff4e2, sunGain: 1.5, sunSize: 0.012,
      planet: { color: 0xc3cfda, atmo: 0xffffff, size: 0.08, azimuth: 300, elevation: 30, bands: 0.2 },
    },
    // A low-ish sun (42 deg) rather than daybreak's near-overhead 58: the references are built
    // out of long raking shadows down the wall faces, which a high sun flattens away entirely.
    lights: {
      key: { color: 0xfff4e2, intensity: 3.1, azimuth: 40, elevation: 42 },
      // Ambient leans green, not blue -- on a map this overgrown the bounce light is coming off
      // leaf litter and moss as much as off the sky.
      ambient: { color: 0x93a892, intensity: 1.0 },
      overhead: { color: 0xffffff, intensity: 4, distance: 20, height: 8 },
      rim: { color: 0xcfe0ee, intensity: 0.35, azimuth: 220, elevation: 20 },
      accents: { colorA: 0xffffff, colorB: 0xffffff, intensity: 0, height: 2.4, radius: 14 },
    },
    mats: {
      floor: {
        color: 0x55603f, roughness: 1.0, metalness: 0.0, reflectMetalness: 0.1, reflectRoughness: 0.7,
        // Ground moss: optional, like the concrete block. Absent on every other theme.
        mossColor: 0x3f5f2a, mossGain: 0.85, mossScale: 0.5,
        gridColor: 0xffffff, gridPitch: 3, gridWidth: 0.05, gridGain: 0.0, gridFade: 80,
        vignette: 0.14, scanColor: 0xffffff, scanGain: 0.0, scanPeriod: 6, scanSpeed: 9, scanWidth: 1.2,
      },
      wall: {
        color: 0x9fa19c, roughness: 0.95, metalness: 0.0,
        trimColor: 0xb8bcb6, trimGain: 0.0, trimTop: 0.94, trimBottom: 0.05, trimWidth: 0.03,
        pulseGain: 0.0, pulseSpeed: 1.0, pulseScale: 0.14,
        rimColor: 0xffffff, rimGain: 0.0, rimPower: 3.0,
        // Panels are the primary form system (references 07/08/12); the board grain rides under
        // them at a low gain so the surface still has horizontal tooth close up.
        concrete: {
          gain: 1.0,
          panelW: 2.4, panelH: 1.8, seamWidth: 0.018, seamDark: 0.42,
          boardPitch: 0.22, boardWidth: 0.01, boardGain: 0.25, boardToneVar: 0.06,
          tieGain: 0.55, tieRadius: 0.032, tieH: 1.2, tieV: 0.9,
          grainGain: 0.30, mottleGain: 0.22,
          stainColor: 0x4d5150, stainGain: 0.45, stainLength: 0.55,
          mossColor: 0x4a6b32, mossGain: 1.4,
          algaeGain: 0.9, algaeHeight: 0.3,
        },
      },
      cover: {
        color: 0x8f918b, roughness: 0.95, metalness: 0.0,
        stripeColor: 0xb8bcb6, stripeGain: 0.0, stripePitch: 0.5, capColor: 0xffffff, capGain: 0.0,
        // Cover sits in the wet at ground level and is small enough to be swallowed, so it
        // weathers harder than the walls: more moss on the caps, more algae up the sides.
        concrete: {
          gain: 1.0,
          panelW: 1.6, panelH: 1.2, seamWidth: 0.016, seamDark: 0.38,
          boardPitch: 0.18, boardWidth: 0.01, boardGain: 0.3, boardToneVar: 0.07,
          tieGain: 0.3, tieRadius: 0.028, tieH: 0.9, tieV: 0.7,
          grainGain: 0.34, mottleGain: 0.28,
          stainColor: 0x474b48, stainGain: 0.4, stainLength: 0.6,
          mossColor: 0x466530, mossGain: 1.7,
          algaeGain: 1.2, algaeHeight: 0.45,
        },
      },
    },
    // Daylight already reads the bots (same reasoning as daybreak) -- emission would only wash
    // them out against the pale concrete, which is the one background they can be lost against.
    bots: {
      shellGlow: 0.06, plateGlow: 0.02, trimGlow: 0.05, eyeGlow: 0.5, eyeColor: 0xffd9a0,
      rimColor: 0x2c3626, rimGain: 0.18, rimPower: 3.0,
      poolGain: 0.0, poolRadius: 0.75,
      flashTintColor: 0xffb347, flashTintCycle: 0,
      flashColor: 0xfff0cc, flashIntensity: 20, flashDistance: 9, flashLife: 0.05,
      beamColor: 0xffffff, beamGain: 0.06, beamLength: 8, beamAngle: 15, beamIntensity: 12,
    },
    post: {
      tone: 'agx', exposure: 1.0,
      bloom: { strength: 0.08, radius: 0.6, threshold: 0.9 },
      // Saturation stays just under 1: concrete wants to be grey, but pull it much lower and the
      // greens that are the entire point of the theme go grey with it.
      grade: { contrast: 1.06, saturation: 0.95, gamma: 1.0, temperature: -0.02, tint: 0.02, vignette: 0.14, vignetteSoft: 1.1 },
    },
    env: { intensity: 0.9 },
    flora: {
      grassDensity: 26, grassHeight: 0.42, grassHeightVar: 0.34,
      grassBase: 0x24361a, grassTip: 0x6f9440, grassStyle: 'mottle', bladeCap: 720000, wind: 0.7,
      // Raised from 0.22 now that the wall mask culls the open ground: this is the density in the
      // band against the concrete, and open ground keeps a quarter of it.
      plantDensity: 0.55, plantReach: 1.8, plantOpenFloor: 0.25, plantClumpRadius: 1.2,
      speciesHeight: {}, speciesDensity: {},
      vineDensity: 0.45, vineLength: 1.5, vineClump: 0.35, vineLeafiness: 1, vineBranch: 0.3,
      clearance: 0.35,
    },
  }),
};

export const THEME_KEYS = Object.keys(THEMES);
export const DEFAULT_THEME = 'internetcore';

export function getTheme(key) {
  return THEMES[key] || THEMES[DEFAULT_THEME];
}

// Deep clone so the live system can mutate a theme (panel sliders) without editing THEMES.
export function cloneTheme(t) {
  return JSON.parse(JSON.stringify(t));
}

// Merges a theme's own `toggles` over DEFAULT_TOGGLES. A theme states only what it changes.
export function togglesFor(t) {
  return { ...DEFAULT_TOGGLES, ...(t.toggles || {}) };
}

// Same merge-over-defaults idea for the two optional blocks, so every read site gets a complete
// object and no caller has to spell out `?? 0` per field.
export function concreteFor(matBlock) {
  return { ...CONCRETE_OFF, ...(matBlock && matBlock.concrete) };
}

export function floraFor(t) {
  const f = { ...FLORA_OFF, ...(t && t.flora) };
  // Copied, not shared: a spread aliases FLORA_OFF's own maps, and the panel writes into these.
  f.speciesHeight = { ...f.speciesHeight };
  f.speciesDensity = { ...f.speciesDensity };
  f.grassLook = { ...f.grassLook };
  return f;
}

// ─── procedural themes ──────────────────────────────────────────────────────
// Rolls a coherent look from one seed: a base hue for the structure, a neon accent a fixed
// distance around the wheel, and a secondary accent opposite it. Everything else is derived
// so the result is always internally consistent (dark deck + bright trim, or the inverse).

const HARMONIES = [0.5, 0.33, 0.16, 0.08];   // complementary / triadic / analogous+ / analogous
const TRIM_LUMA_GAP = 0.2;   // minimum accent-over-surface luminance gap for readable neon

// Walks an accent hue toward white-hot until it clears `surface` by TRIM_LUMA_GAP. A saturated
// hue at l=0.6 can easily be darker than the surface it glows on (deep blues especially), and a
// neon that doesn't out-luma its wall just disappears.
function accentOver(hue, sat, surface, startL = 0.6) {
  let l = startL;
  let hex = hslHex(hue, sat, l);
  const target = luma(surface) + TRIM_LUMA_GAP;
  for (let i = 0; i < 32 && luma(hex) < target && l < 0.94; i++) {
    l = Math.min(0.94, l + 0.04);
    hex = hslHex(hue, sat * (1 - (l - startL) * 0.7), l);
  }
  return { hex, l };
}

export function randomTheme(seed) {
  const rng = makeRng(seed);
  const hue = rng();
  const harmony = HARMONIES[Math.floor(rng() * HARMONIES.length)];
  const accentHue = (hue + harmony) % 1;
  const secondHue = (accentHue + 0.5) % 1;
  const bright = rng() < 0.25;                       // occasionally a light-on-dark inversion
  const neonSat = 0.75 + rng() * 0.25;
  const structS = bright ? 0.10 : 0.24;
  let structL = bright ? 0.42 + rng() * 0.16 : 0.09 + rng() * 0.09;

  // A pale "bright" structure can outrun any accent hue; darken it until the primary accent has
  // room to clear it, then let accentOver() do the rest.
  let structure = hslHex(hue, structS, structL);
  for (let i = 0; i < 24 && luma(hslHex(accentHue, neonSat * 0.3, 0.94)) - luma(structure) < TRIM_LUMA_GAP; i++) {
    structL *= 0.86;
    structure = hslHex(hue, structS, structL);
  }
  const primary = accentOver(accentHue, neonSat, structure);
  const accent = primary.hex;
  const deckL = structL * (bright ? 0.72 : 0.55);
  const deck = hslHex(hue, bright ? 0.08 : 0.30, deckL);
  const coverCol = lerpHex(structure, accent, 0.12);
  // The secondary accent lands on cover pieces, so it clears the brighter of wall/cover.
  const second = accentOver(secondHue, neonSat * 0.9,
    luma(coverCol) > luma(structure) ? coverCol : structure, Math.max(0.6, primary.l)).hex;
  const gridAccent = accentOver(accentHue, neonSat, deck, primary.l).hex;
  const voidCol = hslHex(hue, 0.4, Math.min(0.14, structL * 0.4));
  const neonGain = bright ? 0.6 + rng() * 0.6 : 1.4 + rng() * 1.4;

  return {
    key: 'random', label: `Random #${seed >>> 0}`,
    toggles: {
      sky: true, stars: true, nebula: rng() < 0.8, planet: rng() < 0.5,
      scan: rng() < 0.5, grid: true, trim: true, pulse: rng() < 0.7, rim: true,
      flashlights: !bright && rng() < 0.25,
    },
    bg: voidCol,
    fog: { color: voidCol, density: 0.008 + rng() * 0.03 },
    sky: {
      horizon: hslHex(accentHue, 0.6, bright ? 0.5 : 0.12), zenith: voidCol, groundTint: shadeHex(voidCol, 0.7),
      nebulaA: accent, nebulaB: second, nebulaGain: 0.25 + rng() * 0.45,
      nebulaScale: 2 + rng() * 1.6, nebulaTilt: rng() * 1.2,
      starGain: 0.5 + rng() * 1.0, starDensity: 0.7 + rng() * 1.1, starTwinkle: 0.4 + rng() * 1.1,
      starWrap: rng() < 0.75 ? 1 : rng() * 0.6,
      sunColor: hslHex(accentHue, 0.5, 0.85), sunGain: 0.4 + rng() * 1.1, sunSize: 0.012 + rng() * 0.04,
      planet: {
        color: hslHex(secondHue, 0.5, 0.28), atmo: second,
        size: 0.10 + rng() * 0.34, azimuth: rng() * 360, elevation: 4 + rng() * 26, bands: 0.2 + rng() * 0.6,
      },
    },
    lights: {
      key: { color: hslHex(hue, 0.15, 0.9), intensity: bright ? 2.4 + rng() : 0.7 + rng() * 1.4, azimuth: rng() * 360, elevation: 25 + rng() * 45 },
      ambient: { color: hslHex(accentHue, 0.45, bright ? 0.6 : 0.2), intensity: 0.3 + rng() * 0.6 },
      overhead: { color: accent, intensity: 12 + rng() * 18, distance: 18 + rng() * 10, height: 6 + rng() * 3 },
      rim: { color: second, intensity: 0.4 + rng() * 1.2, azimuth: rng() * 360, elevation: 8 + rng() * 16 },
      accents: { colorA: accent, colorB: second, intensity: bright ? 0 : 10 + rng() * 22, height: 2 + rng(), radius: 12 + rng() * 6 },
    },
    mats: {
      floor: {
        color: deck, roughness: 0.4 + rng() * 0.5, metalness: rng() * 0.25,
        reflectMetalness: 0.55 + rng() * 0.35, reflectRoughness: 0.1 + rng() * 0.2,
        gridColor: gridAccent, gridPitch: 2 + rng() * 2, gridWidth: 0.04 + rng() * 0.03,
        gridGain: neonGain, gridFade: 40 + rng() * 50,
        vignette: 0.2 + rng() * 0.4, scanColor: second, scanGain: neonGain * 0.9,
        scanPeriod: 4 + rng() * 5, scanSpeed: 8 + rng() * 8, scanWidth: 0.8 + rng() * 0.8,
      },
      wall: {
        color: structure, roughness: 0.5 + rng() * 0.4, metalness: rng() * 0.3,
        trimColor: accent, trimGain: neonGain, trimTop: 0.88 + rng() * 0.08, trimBottom: 0.03 + rng() * 0.05,
        trimWidth: 0.02 + rng() * 0.025,
        pulseGain: rng() * 2.0, pulseSpeed: 0.6 + rng() * 2.0, pulseScale: 0.08 + rng() * 0.1,
        rimColor: second, rimGain: 0.15 + rng() * 0.35, rimPower: 2.4 + rng() * 2.0,
      },
      cover: {
        color: coverCol, roughness: 0.45 + rng() * 0.45, metalness: rng() * 0.25,
        stripeColor: second, stripeGain: neonGain * 0.7, stripePitch: 0.3 + rng() * 0.3,
        capColor: accent, capGain: neonGain,
      },
    },
    // Bot emission tracks the map's neon gain so a dim roll doesn't produce bright bots on a dead
    // map (or the reverse); a `bright` roll has real light, so it needs almost none of it.
    bots: {
      shellGlow: neonGain * 0.8, plateGlow: neonGain * 0.2,
      // Visor takes the roll's accent while the rim takes the second colour, so a roll always
      // pairs the palette's two hues on the bot instead of washing it in one.
      trimGlow: neonGain * 0.4, eyeGlow: neonGain, eyeColor: accent,
      rimColor: second, rimGain: bright ? 0.1 + rng() * 0.25 : 0.4 + rng() * 0.6, rimPower: 2.4 + rng() * 1.4,
      poolGain: bright ? rng() * 0.2 : 0.25 + rng() * 0.5, poolRadius: 0.7 + rng() * 0.2,
      // Deliberately NOT keyed to accentHue like everything else in this roll: a muzzle flash is
      // burning propellant, so it is warm on every map. The jitter stays inside the incandescent
      // band (hue ~22-47 deg) — a roll may vary how orange the flash is, never whether it is warm.
      flashColor: hslHex(0.06 + rng() * 0.07, 0.30 + rng() * 0.25, 0.86), flashIntensity: 22 + rng() * 24,
      flashDistance: 9 + rng() * 6, flashLife: 0.05 + rng() * 0.04,
      // The tint is the opposite case: it exists to be unphysical, so it takes the roll's accent.
      flashTintColor: accent, flashTintCycle: rng() < 0.4 ? 0.1 + rng() * 0.5 : 0,
      beamColor: hslHex(accentHue, 0.30, 0.88), beamGain: bright ? 0.04 + rng() * 0.08 : 0.12 + rng() * 0.18,
      beamLength: 8 + rng() * 5, beamAngle: 13 + rng() * 7, beamIntensity: 18 + rng() * 24,
    },
    post: {
      tone: ['agx', 'aces', 'neutral'][Math.floor(rng() * 3)], exposure: 0.95 + rng() * 0.35,
      bloom: { strength: 0.15 + rng() * 0.7, radius: 0.6 + rng() * 0.35, threshold: 0.3 + rng() * 0.45 },
      grade: {
        contrast: 1.0 + rng() * 0.35, saturation: 0.9 + rng() * 0.5, gamma: 0.95 + rng() * 0.12,
        temperature: (rng() - 0.5) * 0.16, tint: (rng() - 0.5) * 0.16,
        vignette: 0.15 + rng() * 0.45, vignetteSoft: 0.8 + rng() * 0.5,
      },
    },
    env: { intensity: 0.3 + rng() * 0.8 },
  };
}

// ─── validation (what the Node test asserts) ────────────────────────────────

const REQUIRED = {
  fog: ['color', 'density'],
  sky: ['horizon', 'zenith', 'groundTint', 'nebulaA', 'nebulaB', 'nebulaGain', 'nebulaScale',
    'nebulaTilt', 'starGain', 'starDensity', 'starTwinkle', 'starWrap', 'sunColor', 'sunGain',
    'sunSize', 'planet'],
  'sky.planet': ['color', 'atmo', 'size', 'azimuth', 'elevation', 'bands'],
  lights: ['key', 'ambient', 'overhead', 'rim', 'accents'],
  'lights.key': ['color', 'intensity', 'azimuth', 'elevation'],
  'lights.ambient': ['color', 'intensity'],
  'lights.overhead': ['color', 'intensity', 'distance', 'height'],
  'lights.rim': ['color', 'intensity', 'azimuth', 'elevation'],
  'lights.accents': ['colorA', 'colorB', 'intensity', 'height', 'radius'],
  mats: ['floor', 'wall', 'cover'],
  'mats.floor': ['color', 'roughness', 'metalness', 'reflectMetalness', 'reflectRoughness',
    'gridColor', 'gridPitch', 'gridWidth', 'gridGain', 'gridFade', 'vignette',
    'scanColor', 'scanGain', 'scanPeriod', 'scanSpeed', 'scanWidth'],
  'mats.wall': ['color', 'roughness', 'metalness', 'trimColor', 'trimGain', 'trimTop', 'trimBottom',
    'trimWidth', 'pulseGain', 'pulseSpeed', 'pulseScale', 'rimColor', 'rimGain', 'rimPower'],
  'mats.cover': ['color', 'roughness', 'metalness', 'stripeColor', 'stripeGain', 'stripePitch', 'capColor', 'capGain'],
  bots: ['shellGlow', 'plateGlow', 'trimGlow', 'eyeGlow', 'eyeColor', 'rimColor', 'rimGain', 'rimPower',
    'poolGain', 'poolRadius', 'flashColor', 'flashIntensity', 'flashDistance', 'flashLife',
    'flashTintColor', 'flashTintCycle',
    'beamColor', 'beamGain', 'beamLength', 'beamAngle', 'beamIntensity'],
  post: ['tone', 'exposure', 'bloom', 'grade'],
  'post.bloom': ['strength', 'radius', 'threshold'],
  'post.grade': ['contrast', 'saturation', 'gamma', 'temperature', 'tint', 'vignette', 'vignetteSoft'],
  env: ['intensity'],
};

function at(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

// Returns [] for a well-formed theme, else one string per problem.
export function validateTheme(t) {
  const errs = [];
  if (!t || typeof t !== 'object') return ['theme is not an object'];
  for (const s of THEME_SECTIONS) if (t[s] === undefined) errs.push(`missing section: ${s}`);
  if (typeof t.bg !== 'number') errs.push('bg must be a hex number');
  for (const [path, keys] of Object.entries(REQUIRED)) {
    const node = at(t, path);
    if (node == null) { errs.push(`missing: ${path}`); continue; }
    for (const k of keys) if (node[k] === undefined) errs.push(`missing: ${path}.${k}`);
  }
  const tones = ['agx', 'aces', 'reinhard', 'neutral', 'none'];
  if (t.post && !tones.includes(t.post.tone)) errs.push(`post.tone must be one of ${tones.join('|')}`);
  return errs;
}

// Backfills whole sections (and individual keys) a theme predates. The panel's save/load slots
// store a theme verbatim rather than by key — sliders edit it in place — so a slot written before
// a section existed would otherwise reach the renderer as undefined and throw on first read.
export function normalizeTheme(t) {
  const base = THEMES[DEFAULT_THEME];
  const out = t && typeof t === 'object' ? cloneTheme(t) : cloneTheme(base);
  if (typeof out.bg !== 'number') out.bg = base.bg;
  for (const s of THEME_SECTIONS) {
    if (s === 'bg') continue;
    if (out[s] === undefined || out[s] === null) out[s] = cloneTheme(base[s]);
  }
  // Saved look states predating the visor slot have no bots.eyeColor; the generic backfill below
  // would hand them the DEFAULT theme's, repainting somebody else's saved visor. Their visor was
  // the rim colour, so restore exactly that.
  const eyeMissing = out.bots != null && out.bots.eyeColor === undefined;
  for (const [path, keys] of Object.entries(REQUIRED)) {
    const node = at(out, path), ref = at(base, path);
    if (node == null || ref == null) continue;
    for (const k of keys) {
      if (node[k] !== undefined) continue;
      node[k] = ref[k] !== null && typeof ref[k] === 'object' ? cloneTheme(ref[k]) : ref[k];
    }
  }
  if (eyeMissing && typeof out.bots.rimColor === 'number') out.bots.eyeColor = out.bots.rimColor;
  return out;
}

// ─── bot lighting maths (driven by bot-viewer-visuals.js, tested in Node) ───

// Muzzle-flash brightness over its life: instant attack, quadratic decay, 0 outside [0, life).
// A flash that faded linearly reads as a lamp switching off rather than a discharge.
export function flashCurve(age, life) {
  if (!(life > 0) || !(age >= 0) || age >= life) return 0;
  const t = 1 - age / life;
  return t * t;
}

// Fits a directional key light and its ortho shadow box to an arena. Everything is derived from
// the arena's bounding SPHERE rather than its box, so a single fit stays correct at every sun angle
// a theme can pick — no re-fit when the azimuth changes. `height` is the vertical span the box must
// cover (walls + terrain relief), `margin` how far outside the sphere the light is parked.
export function fitShadowBox(bounds, height, margin = 10) {
  const cx = (bounds.minX + bounds.maxX) / 2, cz = (bounds.minZ + bounds.maxZ) / 2;
  const w = Math.max(1, bounds.maxX - bounds.minX), d = Math.max(1, bounds.maxZ - bounds.minZ);
  const h = Math.max(1, height);
  const radius = 0.5 * Math.hypot(w, d, h);
  const dist = radius + Math.max(0, margin);
  return { cx, cy: h / 2, cz, radius, dist, near: Math.max(0.1, dist - radius), far: dist + radius };
}

// Real dynamic lights are a fixed, small budget shared by every flash on screen, so each frame the
// loudest `capacity` requests win and the rest are simply not lit. Ties break on insertion order
// so a light that is already burning never loses its slot to an equal newcomer (which would strobe).
// Allocation-free variant: fills a caller-owned `out` array. This runs every frame of every
// firefight, so the sort-and-slice form below (3 intermediate arrays + a wrapper per request)
// was handing the GC steady work exactly when the frame budget is tightest.
export function pickLightSlotsInto(requests, capacity, out) {
  out.length = 0;
  if (!Array.isArray(requests) || !(capacity > 0)) return out;
  for (let n = 0; n < requests.length; n++) {
    const r = requests[n];
    // Walk left while the incumbent is dimmer; stopping on equal keeps insertion order.
    let j = out.length;
    while (j > 0 && out[j - 1].weight < r.weight) j--;
    if (j >= capacity) continue;                       // dimmer than every slot already filled
    const len = Math.min(out.length + 1, capacity);
    out.length = len;
    for (let k = len - 1; k > j; k--) out[k] = out[k - 1];
    out[j] = r;
  }
  return out;
}

export function pickLightSlots(requests, capacity) {
  return pickLightSlotsInto(requests, capacity, []);
}

// Ground-pool size from the bot's own capsule height: a crouched or prone bot is shorter and more
// sprawled, so its contact patch widens. Stance therefore reads from overhead with no extra state.
export function poolScaleForHeight(height, standing = 1.7) {
  if (!(height > 0) || !(standing > 0)) return 1;
  const r = Math.min(1, height / standing);
  return Math.min(1.6, 0.9 + (1 - r) * 0.9);
}

// ─── audio-reactive routing (driven by bot-viewer-visuals.js update(), tested in Node) ───

// What each band drives. The point of a table rather than one shared envelope is that the scene
// stops moving as a single blob: kick drum lands on the heavy things (corner lights, wall trim),
// hats and voices flicker the bots, and broadband loudness swells bloom and sky. `depth` is how
// far that target is allowed to travel — the bands say WHEN, depth says HOW MUCH.
export const REACTIVE_TARGETS = {
  // `lights` and `bloom` reproduce the original single-envelope behaviour exactly (depth 1).
  lights: { label: 'Lights', bass: 0.9, mid: 0, treble: 0, level: 0, beat: 0.7, depth: 1, hint: 'Corner accent lights punch on the kick' },
  bloom: { label: 'Bloom', bass: 0, mid: 0, treble: 0, level: 0.5, beat: 0.35, depth: 1, hint: 'Whole-frame glow swells with loudness' },
  neon: { label: 'Neon', bass: 0.55, mid: 0.25, treble: 0, level: 0, beat: 0.5, depth: 0.6, hint: 'Wall trim, floor grid and hazard stripes pulse' },
  bots: { label: 'Bots', bass: 0, mid: 0.3, treble: 0.7, level: 0, beat: 0.55, depth: 0.7, hint: 'Bot shells, visors and ground pools flicker on the highs' },
  sky: { label: 'Sky', bass: 0.2, mid: 0, treble: 0.25, level: 0.35, beat: 0, depth: 0.5, hint: 'Nebula and starfield breathe (off by default — taste)' },
};

export const REACTIVE_KEYS = Object.keys(REACTIVE_TARGETS);

// Ceiling on the pump any one target can reach. drive maxes at 2.5 and weights sum to ~1.6, so
// without this a loud passage would take neon to ~4x and blow the whole map to white.
export const REACTIVE_MAX = 2.0;

// Sky is opt-in: a pulsing starfield reads as a rendering bug to some eyes, and unlike the rest
// it is behind everything, so it moves the whole image at once.
export function defaultReactiveTargets() {
  return { lights: true, bloom: true, neon: true, bots: true, sky: false };
}

// The additive boost for one target: 0 means "leave the theme value alone". Callers apply it as
// `base * (1 + gain)`, so a target whose theme gain is 0 stays dark however loud the track is.
export function reactiveGain(mix, weights, drive = 1) {
  if (!mix || !weights) return 0;
  const d = Number.isFinite(drive) ? Math.max(0, drive) : 0;
  if (d <= 0) return 0;
  const g = (mix.bass || 0) * (weights.bass || 0)
    + (mix.mid || 0) * (weights.mid || 0)
    + (mix.treble || 0) * (weights.treble || 0)
    + (mix.level || 0) * (weights.level || 0)
    + (mix.beat || 0) * (weights.beat || 0);
  if (!(g > 0)) return 0;
  const depth = Number.isFinite(weights.depth) ? weights.depth : 1;
  return Math.min(REACTIVE_MAX, g * d * Math.max(0, depth));
}

// Smooths raw analyser output toward the display mix, in place. Bands lag deliberately (a light
// that tracked the FFT frame-for-frame strobes); the beat flag is near-instant so a kick reads as
// a hit rather than a swell. `levels` null = the feature is off or the track is paused, and the
// mix decays to rest — which is what makes toggling it ramp instead of snap.
export function advanceAudioMix(mix, levels, dt) {
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const k = Math.min(1, step * 12);
  const kBeat = Math.min(1, step * 20);
  const at = key => (levels && Number.isFinite(levels[key]) ? levels[key] : 0);
  mix.bass += (at('bass') - mix.bass) * k;
  mix.mid += (at('mid') - mix.mid) * k;
  mix.treble += (at('treble') - mix.treble) * k;
  mix.level += (at('level') - mix.level) * k;
  mix.beat += (at('beat') - mix.beat) * kBeat;
  return mix;
}
