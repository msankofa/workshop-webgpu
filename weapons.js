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

export const WEAPONS = {
  m1911: {
    id: 'm1911',
    displayName: 'M1911',
    mode: 'hitscan',
    model: 'models/guns/low-poly_m1911.glb',
    damage: 18,
    range: 60,
    fireIntervalMs: 220,
    magazineSize: 7,
    reserveAmmo: 35,
    spreadRad: 0.01,
    pelletCount: 1,
    recoil: 0.6,
    tracerColor: [1, 0.85, 0.45],
    viewOffset: [0.30, -0.31, -0.68],
    viewRotation: [-0.02, -0.04, -0.03],
    viewScale: 1.0,
    viewTargetSize: 0.95,
  },
  m24: {
    id: 'm24',
    displayName: 'M24 Sniper Rifle',
    mode: 'hitscan',
    model: 'models/guns/low-poly_m24_sniper_rifle.glb',
    damage: 60,
    range: 200,
    fireIntervalMs: 900,
    magazineSize: 5,
    reserveAmmo: 20,
    spreadRad: 0.002,
    pelletCount: 1,
    recoil: 1.4,
    tracerColor: [1, 0.9, 0.55],
    viewOffset: [0.30, -0.32, -0.70],
    viewRotation: [0, 0, 0],
    viewScale: 1.15,
    viewTargetSize: 1.55,
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
    viewRotation: [0, Math.PI, 0],
    viewScale: 1,
    disabled: true,
  },
  grenade: {
    id: 'grenade',
    displayName: 'Mk2 Grenade',
    mode: 'projectile',
    model: 'models/guns/low-poly_mk2_grenade.glb',
    damage: 80,
    range: 30,
    fireIntervalMs: 1500,
    spreadRad: 0,
    pelletCount: 1,
    recoil: 0.5,
    tracerColor: [0.6, 0.9, 0.4],
    viewOffset: [0.18, -0.2, -0.3],
    viewRotation: [0, 0, 0],
    viewScale: 1,
    disabled: true,
  },
  rpg: {
    id: 'rpg',
    displayName: 'RPG-7',
    mode: 'projectile',
    model: 'models/guns/low-poly_rpg-7.glb',
    damage: 150,
    range: 150,
    fireIntervalMs: 2500,
    spreadRad: 0.004,
    pelletCount: 1,
    recoil: 2.5,
    tracerColor: [1, 0.5, 0.2],
    viewOffset: [0.25, -0.25, -0.7],
    viewRotation: [0, Math.PI, 0],
    viewScale: 1,
    disabled: true,
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
