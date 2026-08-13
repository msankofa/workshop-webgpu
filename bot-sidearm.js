// Pure, THREE-free sidearm logic for the combat-bot FSM: every bot carries a pistol behind its
// primary and draws it instead of reloading mid-gunfight. Sits between the primary and the knife
// on the last-resort ladder (knife only after BOTH guns are dry). Unit-tested in
// test-bot-sidearm.mjs; the viewer owns the ammo pools, timers and the mount swap.

export const SIDEARM_DRAW_MS = 550;   // pistol in hand but not yet shootable -- the cost of the swap
export const SIDEARM_LULL_MS = 2500;  // quiet time before a pistol-carrying bot goes back to its primary
export const SIDEARM_CLOSE_HYST = 1.4; // the target must back off this far past closeRange to re-shoulder
export const PISTOL_IDS = ['m1911', 'five_seven'];

// Deterministic pistol pick: never the bot's own primary, spread across the roster by seed so a
// squad doesn't all carry the same backup. Returns null when no distinct pistol exists.
export function pickSidearmId(primaryId, seed = 0, pistols = PISTOL_IDS) {
  const options = pistols.filter((id) => id !== primaryId);
  if (!options.length) return null;
  const s = Math.floor(Math.abs(Number(seed) || 0));
  return options[s % options.length];
}

// A weapon nobody can shoot with any more: empty mag and nothing to refill it from. `autoRefill`
// (the viewer's infinite-reserve debug toggle) keeps a mag-empty weapon alive; `noAmmo` kills both.
export function weaponDry({ mag = 0, reserve = 0 } = {}, { autoRefill = false, noAmmo = false } = {}) {
  if (noAmmo) return true;
  if (mag > 0) return false;
  return !autoRefill && reserve <= 0;
}

// Which slot should be in hand. Returns 'primary' | 'sidearm' to request a swap, or null to keep
// what's held. The caller owns the draw timer, so `swapping` suppresses re-entry mid-draw.
// `swapOnDryMag` and `closeRange` come from the bot's role (bot-roles.js): a bolt-action sniper
// empties its mag every shot, so it swaps on distance rather than on ammo.
export function chooseWeaponSlot({
  active = 'primary', hasSidearm = false, swapping = false, inGunfight = false, quietMs = Infinity,
  primary = {}, sidearm = {}, swapOnDryMag = true, closeRange = 0, targetDist = Infinity,
} = {}) {
  if (!hasSidearm) return active === 'sidearm' ? 'primary' : null; // toggled off mid-fight: holster it
  if (swapping) return null;
  const primaryMag = primary.mag ?? 0, primaryReserve = primary.reserve ?? 0;
  const sidearmMag = sidearm.mag ?? 0, sidearmReserve = sidearm.reserve ?? 0;
  const primaryHasRounds = primaryMag > 0 || primaryReserve > 0;
  const pressed = closeRange > 0 && targetDist <= closeRange;
  if (active === 'primary') {
    if (sidearmMag <= 0) return null;               // nothing loaded to draw
    if (pressed) return 'sidearm';                  // rushed: the primary is the wrong tool this close
    if (primaryMag > 0) return null;
    if (primaryReserve <= 0) return 'sidearm';      // spent for good
    // Dry mag: draw the pistol when someone is shooting at us -- faster than a reload. Out of
    // contact the bot just reloads, and a role that reloads after every shot never swaps for it.
    return (inGunfight && swapOnDryMag) ? 'sidearm' : null;
  }
  // On the backup. Go back to the primary when the backup is spent, once the target is far enough
  // out that the primary is the better gun again, or once the fight is over (the normal top-off
  // reload then refills the primary while nothing can shoot back).
  if (sidearmMag <= 0 && sidearmReserve <= 0 && primaryHasRounds) return 'primary';
  if (sidearmMag <= 0 && primaryMag > 0) return 'primary';
  if (closeRange > 0 && targetDist > closeRange * SIDEARM_CLOSE_HYST && primaryHasRounds) return 'primary';
  if (!inGunfight && quietMs >= SIDEARM_LULL_MS && primaryHasRounds) return 'primary';
  return null;
}

// Ladder input for the viewer's `fireCapable`/knife rungs: a bot is only truly out of the fight
// when the weapon in hand AND the one on its belt are both dry.
export function outOfAllAmmo({ active = {}, other = {}, hasSidearm = false } = {}, flags = {}) {
  if (!weaponDry(active, flags)) return false;
  return !hasSidearm || weaponDry(other, flags);
}
