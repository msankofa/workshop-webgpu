// Per-player, per-weapon magazine state, lifted verbatim from environment-viewer.html
// (defaultAmmoFor / ensureAmmo / reloadAmmo / consumeAmmo) so the base-game relay and its
// client share the one implementation. No THREE, no clocks.
import { getWeapon } from './weapons.js';

export function defaultAmmoFor(weaponId) {
  const w = getWeapon(weaponId);
  const magazineSize = Math.max(0, w?.magazineSize ?? 0);
  return { mag: magazineSize, reserve: Math.max(0, w?.reserveAmmo ?? 0), magazineSize };
}

export function createAmmoStore() {
  const playerAmmo = new Map();
  const ammoKey = (playerId, weaponId) => `${playerId}:${weaponId}`;
  // Bottomless magazines. Infinity is the whole implementation: `mag -= 1` leaves it Infinity,
  // reloadAmmo's `mag >= magazineSize` short-circuits, and the wire already carries it (protocol
  // wireAmmo sends null, cleanAmmo reads it back) because JSON has no Infinity.
  let unlimited = false;
  const bottomless = (weaponId) => ({ mag: Infinity, reserve: Infinity, magazineSize: Math.max(0, getWeapon(weaponId)?.magazineSize ?? 0) });
  function setUnlimited(next) {
    if (unlimited === !!next) return unlimited;
    unlimited = !!next;
    // Existing magazines follow the switch either way: turning it off hands everyone a full load
    // rather than whatever they happened to have before it was turned on.
    for (const [key, ammo] of playerAmmo) Object.assign(ammo, unlimited ? bottomless(key.slice(key.indexOf(':') + 1)) : defaultAmmoFor(key.slice(key.indexOf(':') + 1)));
    return unlimited;
  }
  function ensureAmmo(playerId, weaponId) {
    const key = ammoKey(playerId, weaponId);
    let ammo = playerAmmo.get(key);
    if (!ammo) { ammo = unlimited ? bottomless(weaponId) : defaultAmmoFor(weaponId); playerAmmo.set(key, ammo); }
    return ammo;
  }
  function reloadAmmo(playerId, weaponId) {
    const ammo = ensureAmmo(playerId, weaponId);
    if (ammo.mag >= ammo.magazineSize || ammo.reserve <= 0) return ammo;
    const needed = ammo.magazineSize - ammo.mag;
    const moved = Math.min(needed, ammo.reserve);
    ammo.mag += moved;
    ammo.reserve -= moved;
    return ammo;
  }
  function consumeAmmo(playerId, weaponId) {
    const ammo = ensureAmmo(playerId, weaponId);
    if (ammo.mag <= 0) return false;
    ammo.mag -= 1;
    return true;
  }
  function resetPlayer(playerId) {
    for (const key of [...playerAmmo.keys()]) if (key.startsWith(`${playerId}:`)) playerAmmo.delete(key);
  }
  return { ensureAmmo, reloadAmmo, consumeAmmo, resetPlayer, removePlayer: resetPlayer, setUnlimited, get unlimited() { return unlimited; } };
}
