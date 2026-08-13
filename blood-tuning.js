// Shared blood FX numbers. bot-viewer-v3 and damage-simulator both build their bursts from here, so
// a tuning session in one ports to the other as plain JSON instead of needing a conversion.
//
// BLOOD_BASE is the absolute shape of one full-intensity hit. BLOOD_TUNING is the five multipliers
// over it. bloodIntensityForHealth (effect-renderer.js) supplies the healthy-to-dying ramp `I`.

export const BLOOD_BASE = {
  spraySize: 0.03,          // droplet radius
  gravity: 9.8,
  stainFixed: 0.15,         // stain size when no part width is available
  stainFit: 0.55,           // fraction of the hit part's cross-section
  stainFitMin: 0.03,
  stainFitMax: 0.16,
  stainOpacity: 0.92,
  stainProjDepth: 0.025,    // projected-decal box reach along the normal; keep under half a limb
  splatterSize: 0.12,
  splatterLifeScale: 1.33,  // ground splatter outlives the body stain
  stumpSprayCount: 34,
  stumpSpraySize: 0.035,
  stumpSplatterCount: 12,
  stumpSplatterSize: 0.14,
  stumpSplatterOpacity: 0.85,
  stumpSpeed: 3.4,
  stumpSpread: 1.1,
};

export const BLOOD_TUNING = {
  amount: 1,      // droplet and splatter counts
  force: 1,       // droplet speed and fan width
  sprayLife: 0.6, // droplet flight time, seconds
  decalLife: 6,   // stain lifetime, seconds
  stainSize: 1,   // every decal, on top of fit-to-part sizing
};

const b = (base, key) => (base && base[key] != null ? base[key] : BLOOD_BASE[key]);
const t = (tune, key) => (tune && tune[key] != null ? tune[key] : BLOOD_TUNING[key]);

// Airborne droplets. Returns null when the tuning has scaled the burst away.
export function sprayParams(I, tune, base) {
  const count = Math.round(I.sprayCount * t(tune, 'amount'));
  if (count <= 0) return null;
  const force = t(tune, 'force');
  return {
    count, size: b(base, 'spraySize'),
    speed: I.spraySpeed * force, spread: I.spraySpread * force,
    gravity: b(base, 'gravity'), life: t(tune, 'sprayLife'),
  };
}

// The mark at the wound. crossSection 0 means the hit never identified a part.
export function stainParams(crossSection, tune, base) {
  const fitted = crossSection > 0
    ? Math.min(b(base, 'stainFitMax'), Math.max(b(base, 'stainFitMin'), b(base, 'stainFit') * crossSection))
    : b(base, 'stainFixed');
  return {
    size: fitted * t(tune, 'stainSize'),
    opacity: b(base, 'stainOpacity'),
    life: t(tune, 'decalLife'),
  };
}

// Where the spray's droplets land on the ground.
export function splatterParams(I, tune, base) {
  const count = Math.round(I.splatterCount * t(tune, 'amount'));
  if (count <= 0) return null;
  const force = t(tune, 'force');
  return {
    count, size: b(base, 'splatterSize') * t(tune, 'stainSize'), opacity: I.splatterOpacity,
    speed: I.spraySpeed * force, spread: I.spraySpread * force,
    gravity: b(base, 'gravity'), life: t(tune, 'decalLife') * b(base, 'splatterLifeScale'),
  };
}

// The one-off burst from a fresh stump. Not health-scaled: losing a limb is always the full thing.
export function stumpParams(tune, base) {
  const force = t(tune, 'force'), amount = t(tune, 'amount');
  return {
    spray: {
      count: Math.round(b(base, 'stumpSprayCount') * amount), size: b(base, 'stumpSpraySize'),
      speed: b(base, 'stumpSpeed') * force, spread: b(base, 'stumpSpread') * force,
      gravity: b(base, 'gravity'), life: t(tune, 'sprayLife'),
    },
    splatter: {
      count: Math.round(b(base, 'stumpSplatterCount') * amount),
      size: b(base, 'stumpSplatterSize') * t(tune, 'stainSize'),
      opacity: b(base, 'stumpSplatterOpacity'),
      speed: b(base, 'stumpSpeed') * force, spread: b(base, 'stumpSpread') * force,
      gravity: b(base, 'gravity'), life: t(tune, 'decalLife') * b(base, 'splatterLifeScale'),
    },
  };
}
