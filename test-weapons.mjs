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
  check(Number.isFinite(w.magazineSize) && w.magazineSize > 0, `${w.id}.magazineSize should be finite and positive â€” got ${w.magazineSize}`);
  check(Number.isFinite(w.reserveAmmo) && w.reserveAmmo >= 0, `${w.id}.reserveAmmo should be finite and non-negative â€” got ${w.reserveAmmo}`);
}

// m1911 and m24 must specifically be enabled per M0 requirements.
check(getWeapon('m1911') && !getWeapon('m1911').disabled, 'm1911 should be defined and enabled');
check(getWeapon('m24') && !getWeapon('m24').disabled, 'm24 should be defined and enabled');

// Future weapons should exist but be disabled.
for (const id of ['knife', 'grenade', 'rpg']) {
  const w = getWeapon(id);
  check(w !== undefined, `${id} should be defined`);
  check(w && w.disabled === true, `${id} should be disabled:true`);
}

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
