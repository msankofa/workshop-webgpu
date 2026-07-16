// Runs in Node.js. Verifies weapons.js config shape (Milestone M0).
import { WEAPONS, loadout, getWeapon, enabledWeapons } from './weapons.js';

let failures = 0;
function check(cond, msg) {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${msg}`);
  }
}

function isFinitePositive(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

const enabled = enabledWeapons();
check(enabled.length > 0, 'enabledWeapons() should return at least one weapon');
check(enabled.every(w => WEAPONS[w.id] === w), 'enabledWeapons() entries should come from WEAPONS');

for (const w of enabled) {
  check(isFinitePositive(w.damage), `${w.id}.damage should be finite and positive â€” got ${w.damage}`);
  check(isFinitePositive(w.range), `${w.id}.range should be finite and positive â€” got ${w.range}`);
  check(isFinitePositive(w.fireIntervalMs), `${w.id}.fireIntervalMs should be finite and positive â€” got ${w.fireIntervalMs}`);
  // Melee (knife) has no magazine — it's unlimited. Ranged/projectile weapons must carry ammo.
  if (w.mode !== 'melee') {
    check(Number.isFinite(w.magazineSize) && w.magazineSize > 0, `${w.id}.magazineSize should be finite and positive â€” got ${w.magazineSize}`);
    check(Number.isFinite(w.reserveAmmo) && w.reserveAmmo >= 0, `${w.id}.reserveAmmo should be finite and non-negative â€” got ${w.reserveAmmo}`);
    check(w.muzzleFx && Array.isArray(w.muzzleFx.offset) && w.muzzleFx.offset.length === 3
      && w.muzzleFx.offset.every(Number.isFinite), `${w.id}.muzzleFx.offset should be a finite vec3`);
    for (const key of ['flashForward', 'flashSize', 'flashGrowth', 'flashDuration', 'flashOpacity',
      'smokeForward', 'smokeTravel', 'smokeSpread', 'smokeRise', 'smokeSize', 'smokeGrowth',
      'smokeDuration', 'smokeOpacity', 'smokeCount']) {
      check(Number.isFinite(w.muzzleFx?.[key]), `${w.id}.muzzleFx.${key} should be finite`);
    }
  }
  // Projectile weapons need a projectile sub-spec (speed + blastRadius drive the flight/blast).
  if (w.mode === 'projectile') {
    check(w.projectile && isFinitePositive(w.projectile.speed), `${w.id}.projectile.speed should be finite and positive`);
    check(w.projectile && isFinitePositive(w.projectile.blastRadius), `${w.id}.projectile.blastRadius should be finite and positive`);
  }
}

// m1911 and m24 must specifically be enabled per M0 requirements.
check(getWeapon('m1911') && !getWeapon('m1911').disabled, 'm1911 should be defined and enabled');
check(getWeapon('m24') && !getWeapon('m24').disabled, 'm24 should be defined and enabled');

// Every weapon in models/guns/ is now wired and enabled.
for (const id of ['five_seven', 'cz_805_bren', 'knife', 'grenade', 'rpg']) {
  const w = getWeapon(id);
  check(w !== undefined, `${id} should be defined`);
  check(w && !w.disabled, `${id} should be enabled (no disabled flag)`);
}
// cz_805_bren is the full-auto weapon.
check(getWeapon('cz_805_bren') && getWeapon('cz_805_bren').automatic === true, 'cz_805_bren should be automatic:true');

// All weapon model paths must be strings under models/guns/.
for (const w of Object.values(WEAPONS)) {
  check(typeof w.model === 'string' && w.model.startsWith('models/guns/'),
    `${w.id}.model should be a string starting with 'models/guns/' â€” got ${JSON.stringify(w.model)}`);
}

// getWeapon() for unknown id returns undefined.
check(getWeapon('does-not-exist') === undefined, 'getWeapon() should return undefined for unknown id');

// loadout.defaultWeapon must resolve to an enabled weapon.
const def = getWeapon(loadout.defaultWeapon);
check(def !== undefined, `loadout.defaultWeapon (${loadout.defaultWeapon}) should resolve to a weapon`);
check(def && !def.disabled, `loadout.defaultWeapon (${loadout.defaultWeapon}) should be enabled`);

if (failures > 0) {
  console.error(`${failures} test(s) failed.`);
  process.exit(1);
} else {
  console.log('weapons.js tests passed.');
  process.exit(0);
}
