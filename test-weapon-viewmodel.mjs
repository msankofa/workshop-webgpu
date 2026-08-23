// node test-weapon-viewmodel.mjs — camera-local first-person weapon pose maths.
import { readFileSync } from 'node:fs';
import { createWeaponViewModel } from './weapon-viewmodel.js';
import { getWeapon } from './weapons.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('FAIL:', m); } };
const poses = JSON.parse(readFileSync('./weapon-poses.json', 'utf8'));

const vm = createWeaponViewModel({ getWeapon });
ok(vm.update(1 / 60, {}).visible === false, 'no weapon: not visible');
vm.setWeapon('cz_805_bren');
const def = getWeapon('cz_805_bren');
let p = vm.update(0, {});
ok(p.visible && Math.abs(p.position[2] - def.viewOffset[2]) < 0.01 && Math.abs(p.rotation[1] - def.viewRotation[1]) < 1e-6,
  'idle pose starts at the authored view offset and rotation');
const idleY = p.position[1];

// ADS lerps to the aim offset.
for (let i = 0; i < 10; i++) p = vm.update(1 / 60, { aim: 1 });
ok(Math.abs(p.position[0] - def.aimOffset[0]) < 0.01 && Math.abs(p.position[1] - def.aimOffset[1]) < 0.01, 'full aim sits on aimOffset');
for (let i = 0; i < 10; i++) p = vm.update(1 / 60, { aim: 0.5 });
ok(Math.abs(p.position[0] - (def.viewOffset[0] + def.aimOffset[0]) * 0.5) < 0.02, 'half aim is midway');

// Running bobs more than walking, and the carry lean pulls the gun across.
let walkAmp = 0, runAmp = 0;
for (let i = 0; i < 120; i++) { p = vm.update(1 / 60, { speed: 2, moveZ: 1 }); walkAmp = Math.max(walkAmp, Math.abs(p.viewBob.y)); }
for (let i = 0; i < 120; i++) { p = vm.update(1 / 60, { speed: 7, running: true, moveZ: 1 }); runAmp = Math.max(runAmp, Math.abs(p.viewBob.y)); }
ok(walkAmp > 0.003 && runAmp > walkAmp, `run bob (${runAmp.toFixed(3)}) exceeds walk bob (${walkAmp.toFixed(3)})`);
ok(vm.state.carryBlend > 0.9 && p.rotation[1] > def.viewRotation[1] + 0.3, 'running carries the gun across the chest');

// Recoil kicks the gun back and up, then decays.
for (let i = 0; i < 30; i++) p = vm.update(1 / 60, {});
const restZ = p.position[2];
vm.recoil();
p = vm.update(1 / 120, {});
ok(p.position[2] > restZ + 0.02, 'recoil pushes the weapon back toward the camera');
for (let i = 0; i < 40; i++) p = vm.update(1 / 60, {});
ok(Math.abs(p.position[2] - restZ) < 0.005, 'recoil decays');

// Reload with the shared sequence moves the weapon and cancels aim; ends on its own.
vm.reload(poses.reloadSequence.cz_805_bren);
let moved = false;
for (let i = 0; i < 30; i++) { p = vm.update(1 / 60, { aim: 1 }); if (Math.hypot(p.position[0] - def.viewOffset[0], p.position[1] - def.viewOffset[1]) > 0.01) moved = true; }
ok(vm.reloading && p.aim === 0 && moved, 'reload plays the sequence delta and cancels aim');
for (let i = 0; i < 200; i++) p = vm.update(1 / 60, {});
ok(!vm.reloading, 'reload finishes');

// Swapping weapons resets transient state.
vm.recoil(); vm.setWeapon('five_seven');
ok(vm.state.recoilT === 0 && vm.weaponId === 'five_seven', 'weapon swap clears recoil');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
