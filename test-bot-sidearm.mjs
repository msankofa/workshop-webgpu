// Node smoke tests for bot-sidearm.js (pistol backup: draw instead of reloading mid-gunfight).
import assert from 'node:assert/strict';
import {
  SIDEARM_DRAW_MS, SIDEARM_LULL_MS, SIDEARM_CLOSE_HYST, PISTOL_IDS,
  pickSidearmId, weaponDry, chooseWeaponSlot, outOfAllAmmo,
} from './bot-sidearm.js';

let checks = 0;
const check = (cond, msg) => { assert.ok(cond, msg); checks++; };

// --- pistol pick ---
check(PISTOL_IDS.includes(pickSidearmId('cz_805_bren', 0)), 'a rifle bot gets a pistol');
check(pickSidearmId('m1911', 0) === 'five_seven', 'the sidearm is never the bot\'s own primary');
check(pickSidearmId('five_seven', 3) === 'm1911', 'the other pistol backs up a pistol primary');
check(pickSidearmId('m1911', 0, ['m1911']) === null, 'no distinct pistol available reads as no sidearm');
{
  const picks = new Set([0, 1, 2, 3].map((seed) => pickSidearmId('cz_805_bren', seed)));
  check(picks.size === 2, 'consecutive seeds spread across both pistols');
  check(pickSidearmId('m24', 7) === pickSidearmId('m24', 7), 'the pick is deterministic per seed');
}

// --- dry test ---
check(weaponDry({ mag: 0, reserve: 0 }), 'no mag and no reserve is dry');
check(!weaponDry({ mag: 1, reserve: 0 }), 'one round in the mag is not dry');
check(!weaponDry({ mag: 0, reserve: 30 }), 'a reloadable weapon is not dry');
check(!weaponDry({ mag: 0, reserve: 0 }, { autoRefill: true }), 'infinite-reserve debug mode never runs dry');
check(weaponDry({ mag: 30, reserve: 90 }, { noAmmo: true }), 'the no-ammo debug toggle dries out a full weapon');

const FULL = { mag: 7, reserve: 21 };
const EMPTY_MAG = { mag: 0, reserve: 90 };
const SPENT = { mag: 0, reserve: 0 };

// --- swap out: only for a dry mag, and only when it matters ---
check(chooseWeaponSlot({ active: 'primary', hasSidearm: true, inGunfight: true,
  primary: { mag: 5, reserve: 90 }, sidearm: FULL }) === null, 'a primary with rounds is kept');
check(chooseWeaponSlot({ active: 'primary', hasSidearm: true, inGunfight: true,
  primary: EMPTY_MAG, sidearm: FULL }) === 'sidearm', 'dry mag in a gunfight draws the pistol');
check(chooseWeaponSlot({ active: 'primary', hasSidearm: true, inGunfight: false,
  primary: EMPTY_MAG, sidearm: FULL }) === null, 'out of contact the bot reloads instead of swapping');
check(chooseWeaponSlot({ active: 'primary', hasSidearm: true, inGunfight: false,
  primary: SPENT, sidearm: FULL }) === 'sidearm', 'a spent primary draws the pistol even out of contact');
check(chooseWeaponSlot({ active: 'primary', hasSidearm: true, inGunfight: true,
  primary: SPENT, sidearm: SPENT }) === null, 'no pistol rounds means no swap (the knife rung takes it)');
check(chooseWeaponSlot({ active: 'primary', hasSidearm: false, inGunfight: true,
  primary: SPENT, sidearm: FULL }) === null, 'a bot without a sidearm never swaps');
check(chooseWeaponSlot({ active: 'primary', hasSidearm: true, swapping: true, inGunfight: true,
  primary: EMPTY_MAG, sidearm: FULL }) === null, 'a swap already in progress is not re-requested');

// --- swap back ---
check(chooseWeaponSlot({ active: 'sidearm', hasSidearm: true, inGunfight: true,
  primary: EMPTY_MAG, sidearm: { mag: 3, reserve: 0 } }) === null, 'a live pistol is kept mid-fight');
check(chooseWeaponSlot({ active: 'sidearm', hasSidearm: true, inGunfight: true,
  primary: SPENT, sidearm: { mag: 0, reserve: 14 } }) === null,
  'a reloadable pistol reloads in hand rather than swapping to a spent primary');
check(chooseWeaponSlot({ active: 'sidearm', hasSidearm: true, inGunfight: true,
  primary: { mag: 4, reserve: 0 }, sidearm: { mag: 0, reserve: 14 } }) === 'primary',
  'a dry pistol mag goes back to a primary that still has rounds chambered');
check(chooseWeaponSlot({ active: 'sidearm', hasSidearm: true, inGunfight: true,
  primary: EMPTY_MAG, sidearm: SPENT }) === 'primary', 'a spent pistol goes back to the reloadable primary');
check(chooseWeaponSlot({ active: 'sidearm', hasSidearm: true, inGunfight: false, quietMs: SIDEARM_LULL_MS,
  primary: EMPTY_MAG, sidearm: FULL }) === 'primary', 'the lull re-holsters and lets the primary reload');
check(chooseWeaponSlot({ active: 'sidearm', hasSidearm: true, inGunfight: false, quietMs: SIDEARM_LULL_MS - 1,
  primary: EMPTY_MAG, sidearm: FULL }) === null, 'a brief lull is not long enough to swap back');
check(chooseWeaponSlot({ active: 'sidearm', hasSidearm: true, inGunfight: false, quietMs: Infinity,
  primary: SPENT, sidearm: FULL }) === null, 'no reason to holster a working pistol for a spent primary');
check(chooseWeaponSlot({ active: 'sidearm', hasSidearm: false, inGunfight: true,
  primary: FULL, sidearm: FULL }) === 'primary', 'disabling sidearms mid-fight holsters the pistol');

// --- role loadouts: a bolt-action primary, and a backup drawn on distance rather than on ammo ---
const BOLT = { mag: 0, reserve: 29 };   // an m24 between shots: the mag IS empty most of the time
check(chooseWeaponSlot({ active: 'primary', hasSidearm: true, inGunfight: true, swapOnDryMag: false,
  primary: BOLT, sidearm: FULL, targetDist: 40, closeRange: 14 }) === null,
  'a sniper works the bolt instead of drawing a pistol every shot');
check(chooseWeaponSlot({ active: 'primary', hasSidearm: true, inGunfight: true, swapOnDryMag: false,
  primary: SPENT, sidearm: FULL, targetDist: 40, closeRange: 14 }) === 'sidearm',
  'a sniper out of rifle rounds still falls back to the pistol');
check(chooseWeaponSlot({ active: 'primary', hasSidearm: true, inGunfight: true, swapOnDryMag: false,
  primary: { mag: 1, reserve: 29 }, sidearm: FULL, targetDist: 9, closeRange: 14 }) === 'sidearm',
  'a rusher inside closeRange draws the pistol even with a round chambered');
check(chooseWeaponSlot({ active: 'sidearm', hasSidearm: true, inGunfight: true, swapOnDryMag: false,
  primary: BOLT, sidearm: FULL, targetDist: 14 * SIDEARM_CLOSE_HYST - 1, closeRange: 14 }) === null,
  'the target must clear closeRange by the hysteresis before the rifle comes back up');
check(chooseWeaponSlot({ active: 'sidearm', hasSidearm: true, inGunfight: true, swapOnDryMag: false,
  primary: BOLT, sidearm: FULL, targetDist: 14 * SIDEARM_CLOSE_HYST + 1, closeRange: 14 }) === 'primary',
  'a target that backs off past the hysteresis gets the rifle again');
check(chooseWeaponSlot({ active: 'sidearm', hasSidearm: true, inGunfight: true, swapOnDryMag: false,
  primary: SPENT, sidearm: FULL, targetDist: 60, closeRange: 14 }) === null,
  'distance alone does not re-shoulder a rifle with nothing in it');
check(chooseWeaponSlot({ active: 'primary', hasSidearm: true, inGunfight: true,
  primary: { mag: 0, reserve: 4 }, sidearm: { mag: 30, reserve: 120 }, targetDist: 30, closeRange: 10 }) === 'sidearm',
  'a technical fights on with the rifle instead of standing through the rocket reload');
check(chooseWeaponSlot({ active: 'primary', hasSidearm: true, inGunfight: true,
  primary: { mag: 1, reserve: 4 }, sidearm: { mag: 30, reserve: 120 }, targetDist: 7, closeRange: 10 }) === 'sidearm',
  'a technical never fires a rocket from inside its own blast radius');
check(chooseWeaponSlot({ active: 'primary', hasSidearm: true, inGunfight: true,
  primary: { mag: 1, reserve: 4 }, sidearm: { mag: 30, reserve: 120 }, targetDist: 30, closeRange: 10 }) === null,
  'a loaded tube at range keeps the rocket in hand');
check(chooseWeaponSlot({ active: 'primary', hasSidearm: true, inGunfight: true, closeRange: 14,
  primary: EMPTY_MAG, sidearm: SPENT, targetDist: 2 }) === null, 'closeRange cannot draw a backup with an empty mag');

// --- ladder input: knife only after both guns are done ---
check(!outOfAllAmmo({ active: EMPTY_MAG, other: SPENT, hasSidearm: true }), 'a reloadable primary is still a fight');
check(!outOfAllAmmo({ active: SPENT, other: FULL, hasSidearm: true }), 'a loaded pistol keeps the bot fire-capable');
check(outOfAllAmmo({ active: SPENT, other: SPENT, hasSidearm: true }), 'both guns spent is out of ammo');
check(outOfAllAmmo({ active: SPENT, other: FULL, hasSidearm: false }), 'the pistol pool is ignored without a sidearm');
check(outOfAllAmmo({ active: FULL, other: FULL, hasSidearm: true }, { noAmmo: true }), 'the no-ammo toggle still forces the knife');
check(!outOfAllAmmo({ active: EMPTY_MAG, other: SPENT, hasSidearm: true }, { autoRefill: true }), 'infinite reserve is never out');

check(SIDEARM_DRAW_MS > 0 && SIDEARM_DRAW_MS < SIDEARM_LULL_MS, 'the draw costs time but less than a lull');

console.log(`bot-sidearm: ${checks} checks passed`);
