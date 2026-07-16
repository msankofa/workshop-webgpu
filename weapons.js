// weapons.js
// Pure weapon config for the multiplayer guns feature (see
// docs/superpowers/specs/2026-07-05-multiplayer-guns-design.md, Milestone M0).
// No Three.js import â€” must stay browser+Node safe so it can be unit-tested
// with plain `node test-weapons.mjs` and imported from combat/host code
// without pulling in any renderer.
//
// Usage:
//   import { getWeapon, enabledWeapons, loadout } from './weapons.js';
//   const def = getWeapon(loadout.defaultWeapon);

// Each ranged weapon owns an independent muzzle profile. `offset` is measured in the
// normalized view-weapon space after the authored muzzle anchor has been transformed out of
// raw GLB coordinates. The remaining values drive the local first-person flash/smoke effect.
const muzzleFx = (overrides = {}) => ({
  offset: [0, 0, 0],
  flashForward: 0.02,
  flashSize: 0.13,
  flashGrowth: 0.4,
  flashDuration: 0.08,
  flashOpacity: 0.85,
  smokeForward: 0,
  smokeTravel: 0.42,
  smokeSpread: 0.06,
  smokeRise: 0.1,
  smokeSize: 0.08,
  smokeGrowth: 0.28,
  smokeDuration: 0.42,
  smokeOpacity: 0.22,
  smokeCount: 2,
  ...overrides,
});

export const WEAPONS = {
  m1911: {
    id: 'm1911',
    displayName: 'M1911',
    mode: 'hitscan',
    model: 'models/guns/low-poly_m1911.glb',
    damage: 33,
    range: 101,
    fireIntervalMs: 340,
    magazineSize: 7,
    reserveAmmo: 35,
    spreadRad: 0.01,
    pelletCount: 1,
    recoil: 3,
    tracerColor: [1, 0.85, 0.45],
    viewOffset: [0.44, -0.38, -0.68],
    // ADS: aimOffset is the fully-aimed view position; optics add FOV zoom + optional scope overlay.
    aimOffset: [0.0, -0.236, -0.59],
    aimRotation: [0, 0, 0],
    aimEyeForward: 0.04,
    sightType: 'iron',
    magnification: 1.2,
    scopeBlur: 0,
    scopeRadius: 0.34,
    scopeCenter: [0.5, 0.5],
    viewRotation: [-0.0175, -0.2094, -0.0349],
    viewScale: 0.99,
    viewTargetSize: 0.95,
    muzzleFx: muzzleFx(),
    // Third-person body-held weapon offset (relative to the body's hold mount), tuned in
    // body-preview.html. Position [x,y,z] meters, rotation [x,y,z] euler, uniform scale.
    // NOTE: values are in the preview's mount space verbatim — the game normalizes the
    // third-person GLB to the preview's 0.62 target (NOT viewTargetSize) so the hold scale,
    // pose offsets (lowReady etc.), and baked anchors all read identically. Do not
    // pre-compensate `scale` for viewTargetSize; that only matches the model size while
    // shrinking the pose/anchor geometry.
    thirdPersonHold: { position: [0.2, 0.44, 0.42], rotation: [-0.04, -0.02, -0.08], scale: 0.68 },
    // Crouch hold: same mount space as thirdPersonHold, dropped to shoulder height.
    crouchHold: { position: [0.2, -0.09, 0.42], rotation: [-0.04, -0.02, -0.08], scale: 0.68 },
    // Prone weapon hold: dropped low and pushed forward so the gun sits at ground level in
    // the outstretched hands. Tuned in body-preview.html (stance=prone).
    proneHold: { position: [0.14, -0.91, 0.98], rotation: [-0.04, -0.02, -0.08], scale: 0.68 },
  },
  five_seven: {
    id: 'five_seven',
    displayName: 'Five-seveN',
    mode: 'hitscan',
    model: 'models/guns/low_poly_five_seven.glb',
    damage: 20,
    range: 65,
    fireIntervalMs: 140,
    magazineSize: 20,
    reserveAmmo: 101,
    spreadRad: 0.012,
    pelletCount: 1,
    recoil: 2.75,
    tracerColor: [1, 0.88, 0.55],
    viewOffset: [0.64, -0.53, -0.97],
    aimOffset: [0.0, -0.32, -0.65],
    aimRotation: [0, 0, 0],
    aimEyeForward: 0.04,
    sightType: 'iron',
    magnification: 1.25,
    scopeBlur: 0,
    scopeRadius: 0.34,
    scopeCenter: [0.5, 0.5],
    viewRotation: [-0.0175, -0.1571, 0.0175],
    viewScale: 1,
    viewTargetSize: 0.95,
    muzzleFx: muzzleFx(),
    // Seeded from m1911 (same pistol class); visually tuned in the later authoring pass.
    thirdPersonHold: { position: [0.2, 0.44, 0.42], rotation: [-0.04, -0.02, -0.08], scale: 0.68 },
    crouchHold: { position: [0.2, -0.09, 0.42], rotation: [-0.04, -0.02, -0.08], scale: 0.68 },
    proneHold: { position: [0.14, -0.91, 0.98], rotation: [-0.04, -0.02, -0.08], scale: 0.68 },
  },
  m24: {
    id: 'm24',
    displayName: 'M24 Sniper Rifle',
    mode: 'hitscan',
    model: 'models/guns/low-poly_m24_sniper_rifle.glb',
    damage: 95,
    range: 230,
    fireIntervalMs: 900,
    magazineSize: 1,
    reserveAmmo: 30,
    spreadRad: 0.002,
    pelletCount: 1,
    recoil: 4,
    tracerColor: [1, 0.9, 0.55],
    viewOffset: [0.43, -0.21, -0.88],
    aimOffset: [0.03, -0.15, -0.61],
    aimRotation: [0, 0, 0],
    aimEyeForward: 0.05,
    sightType: 'optical',
    magnification: 8,
    scopeBlur: 0.19,
    scopeRadius: 0.3,
    scopeCenter: [0.49, 0.46],
    viewRotation: [0, -0.1745, 0],
    viewScale: 1.26,
    viewTargetSize: 1.55,
    muzzleFx: muzzleFx(),
    // Tuned in body-preview.html 2026-07-08.
    thirdPersonHold: { position: [0.3, 0.92, -0.68], rotation: [-0.1, 0.08, -0.08], scale: 2 },
    crouchHold: { position: [0.3, -0.09, -0.68], rotation: [-0.1, 0.08, -0.08], scale: 2 },
    proneHold: { position: [0.35, -0.43, -0.12], rotation: [-0.04, 0.08, -0.08], scale: 2 },
  },
  cz_805_bren: {
    id: 'cz_805_bren',
    displayName: 'CZ 805 Bren',
    mode: 'hitscan',
    automatic: true,        // hold-to-fire; tickAutoFire repeats at fireIntervalMs
    model: 'models/guns/low-poly_cz_805_bren.glb',
    damage: 24,
    range: 120,
    fireIntervalMs: 110,
    magazineSize: 30,
    reserveAmmo: 120,
    spreadRad: 0.02,
    pelletCount: 1,
    recoil: 0.55,
    tracerColor: [1, 0.9, 0.5],
    viewOffset: [0.333, -0.31, -0.67],
    aimOffset: [-0.0125, -0.25, -0.47],
    aimRotation: [-0.006981317007977318, 0, 0],
    aimEyeForward: 0,
    sightType: 'iron',
    magnification: 2.6,
    scopeBlur: 0.46,
    scopeRadius: 0.41,
    scopeCenter: [0.43, 0.5],
    viewRotation: [0, -0.10471975511965977, 0],
    viewScale: 1.3,
    viewTargetSize: 1.3,
    muzzleFx: muzzleFx(),
    // Seeded from m24 (rifle class); visually tuned in the later authoring pass. sightType
    // was left as m24's 'optical' until a playtest caught the AR getting a sniper-scope
    // vignette on ADS -- assault rifles use iron sights here, not the scope overlay.
    thirdPersonHold: { position: [0.3, 0.92, -0.68], rotation: [-0.1, 0.08, -0.08], scale: 2 },
    crouchHold: { position: [0.3, -0.09, -0.68], rotation: [-0.1, 0.08, -0.08], scale: 2 },
    proneHold: { position: [0.35, -0.43, -0.12], rotation: [-0.04, 0.08, -0.08], scale: 2 },
  },
  knife: {
    id: 'knife',
    displayName: 'Combat Knife',
    mode: 'melee',
    model: 'models/guns/low_poly_combat_knife.glb',
    damage: 35,
    range: 2,
    fireIntervalMs: 500,
    spreadRad: 0,
    pelletCount: 1,
    recoil: 0.2,
    tracerColor: [0.9, 0.9, 0.95],
    viewOffset: [0.2, -0.2, -0.35],
    aimOffset: [0.1, -0.2, -0.3],
    aimRotation: [0, Math.PI, 0],
    aimEyeForward: 0,
    sightType: 'iron',
    magnification: 1,
    scopeBlur: 0,
    scopeRadius: 0.34,
    scopeCenter: [0.5, 0.5],
    viewRotation: [0, Math.PI, 0],
    viewScale: 1,
    muzzleFx: muzzleFx({ flashOpacity: 0, smokeOpacity: 0, smokeCount: 0 }),
    // Melee: unlimited (no magazine); applyCombatIntent skips the ammo path for mode 'melee'.
  },
  grenade: {
    id: 'grenade',
    displayName: 'Mk2 Grenade',
    mode: 'projectile',
    model: 'models/guns/low-poly_mk2_grenade.glb',
    damage: 95,
    range: 30,
    fireIntervalMs: 1500,
    magazineSize: 1,
    reserveAmmo: 5,
    spreadRad: 0,
    pelletCount: 1,
    recoil: 0.5,
    tracerColor: [0.6, 0.9, 0.4],
    viewOffset: [0.18, -0.2, -0.3],
    aimOffset: [0.05, -0.18, -0.28],
    aimRotation: [0, 0, 0],
    aimEyeForward: 0.02,
    sightType: 'iron',
    magnification: 1,
    scopeBlur: 0,
    scopeRadius: 0.34,
    scopeCenter: [0.5, 0.5],
    viewRotation: [0, 0, 0],
    viewScale: 1,
    muzzleFx: muzzleFx({ flashOpacity: 0, smokeOpacity: 0, smokeCount: 0 }),
    // Thrown arc: lobs (arc adds upward velocity), falls under gravity, bounces off terrain,
    // detonates on the fuse timer or first solid contact. speed/damage/blastRadius/life/gravity
    // ported from html-game-v2 fireGrenade. See combat-projectile.js.
    projectile: { speed: 35, blastRadius: 15, life: 2.15, radius: 0.35, gravity: 24, arc: [0, 4.8, 0], fuse: 2.0, bounces: true },
  },
  rpg: {
    id: 'rpg',
    displayName: 'RPG-7',
    mode: 'projectile',
    model: 'models/guns/low-poly_rpg-7.glb',
    damage: 110,
    range: 150,
    fireIntervalMs: 2500,
    magazineSize: 1,
    reserveAmmo: 4,
    spreadRad: 0.004,
    pelletCount: 1,
    recoil: 2.5,
    tracerColor: [1, 0.5, 0.2],
    viewOffset: [0.25, -0.25, -0.7],
    aimOffset: [0.0, -0.2, -0.55],
    aimRotation: [0, Math.PI, 0],
    aimEyeForward: 0.03,
    sightType: 'iron',
    magnification: 1.5,
    scopeBlur: 0,
    scopeRadius: 0.34,
    scopeCenter: [0.5, 0.5],
    viewRotation: [0, Math.PI, 0],
    viewScale: 1,
    muzzleFx: muzzleFx({ flashSize: 0.2, smokeSize: 0.12, smokeGrowth: 0.4 }),
    // Flat, fast rocket: no gravity, flies straight until it hits something or its life ends
    // (then fizzles with no blast). speed/damage/blastRadius/life ported from html-game-v2
    // fireRocket. See combat-projectile.js.
    projectile: { speed: 108, blastRadius: 8.2, life: 19, radius: 0.42, gravity: 0, fizzleOnExpire: true },
    // Stand hold authored in body-preview-v3.html 2026-07-11; crouch derived (Y→-0.09 shoulder
    // convention); prone seeded from m24 (placeholder — retune in body-preview.html stance=prone).
    thirdPersonHold: { position: [0.4, 0.96, -1], rotation: [-0.04, -0.02, -0.08], scale: 2 },
    crouchHold: { position: [0.4, -0.09, -1], rotation: [-0.04, -0.02, -0.08], scale: 2 },
    proneHold: { position: [0.35, -0.43, -0.12], rotation: [-0.04, 0.08, -0.08], scale: 2 },
  },
};

export const loadout = {
  defaultWeapon: 'm1911',
};

export function getWeapon(id) {
  return WEAPONS[id];
}

export function enabledWeapons() {
  return Object.values(WEAPONS).filter(w => !w.disabled);
}
