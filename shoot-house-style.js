// shoot-house-style.js — the "internetcore" aesthetic system: palette + per-material PBR specs.
// Pure data, no Three.js. Single source of aesthetic truth: the demo room, and every later room /
// house, consume these specs so a look improvement here propagates downstream automatically.
// The builder (shoot-house.js) turns each spec into a MeshStandardNodeMaterial; `em: true` marks an
// emissive bucket (color used as both albedo and emissive, so it glows under bloom).

export const PALETTE = {
  void:    0x08090f, // background-black
  deck:    0x0c0e16, // floor body
  panel:   0x141826, // wall body
  cover:   0x161b2b, // cover body
  cyan:    0x39f0ff, // primary neon
  magenta: 0xff3df0, // secondary neon
  violet:  0x8b5cff, // transitional
  amber:   0xffb020, // warning / signage accent
};

// material key -> { color, roughness, metalness, em?, emissiveIntensity? }
// Metalness kept low everywhere: there is no environment map, so metals would read near-black.
export const MATERIALS = {
  // ---- internetcore (demo room + future rooms) ----
  deck:    { color: PALETTE.deck,    roughness: 0.5,  metalness: 0.1 },              // dark semi-matte floor
  grid:    { color: PALETTE.cyan,    roughness: 1,    metalness: 0, em: true, emissiveIntensity: 2.6 }, // glowing floor grid
  panel:   { color: PALETTE.panel,   roughness: 0.55, metalness: 0.1 },              // wall body
  neon:    { color: PALETTE.cyan,    roughness: 1,    metalness: 0, em: true, emissiveIntensity: 1.3 }, // wall/portal/cover trim (cyan wing)
  neonMagenta: { color: PALETTE.magenta, roughness: 1, metalness: 0, em: true, emissiveIntensity: 1.3 }, // trim accent for the magenta wing (phase-3 zoning)
  cover:   { color: PALETTE.cover,   roughness: 0.45, metalness: 0.1 },              // cover body
  placard: { color: PALETTE.amber,   roughness: 1,    metalness: 0, em: true, emissiveIntensity: 2.2 }, // signage

  // ---- legacy v2 house (kept so the procedural house still builds until it is migrated) ----
  floor:  { color: 0x2a2a2c, roughness: 0.9, metalness: 0 },
  wall:   { color: 0x8a8a86, roughness: 0.9, metalness: 0 },
  trim:   { color: 0xa8a8a4, roughness: 0.9, metalness: 0 },
  stair:  { color: 0x6e6e6c, roughness: 0.9, metalness: 0 },
  exit:   { color: 0x1affa0, roughness: 0.9, metalness: 0, em: true, emissiveIntensity: 2.2 },
  hazard: { color: 0xff3b30, roughness: 0.9, metalness: 0, em: true, emissiveIntensity: 2.2 },
};

export const DEFAULT_MATERIAL = { color: 0x808080, roughness: 0.9, metalness: 0 };
