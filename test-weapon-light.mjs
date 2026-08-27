// weapon-light.js: the weapon flashlight. Headless — a real THREE scene, no renderer. The geometry
// and the ramp are pure; the rest is checked through the two resident lights the module owns.
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import {
  createWeaponLight, placeFlashlight, rampToward, flashlightColor, coneAngleRad,
  WEAPON_LIGHT_DEFAULTS, WEAPON_LIGHT_COOL,
} from './weapon-light.js';

let pass = 0, fail = 0;
const ok = (condition, message) => { if (condition) pass++; else { fail++; console.error('FAIL:', message); } };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---- the ramp ----
ok(rampToward(0, 1, 1, 26) > 0.99, 'a full second at the default rate is all the way on');
ok(rampToward(0, 1, 1 / 60, 26) > 0 && rampToward(0, 1, 1 / 60, 26) < 1, 'one frame is part of the way there');
ok(rampToward(1, 0, 1, 26) < 0.01, 'and it comes back down the same way');
{
  // Frame-rate independence is the whole reason it is an exponential and not a fixed step: two half
  // steps must land where one whole step does, or the beam fades at a different speed per machine.
  const one = rampToward(0, 1, 0.1, 8);
  const two = rampToward(rampToward(0, 1, 0.05, 8), 1, 0.05, 8);
  ok(near(one, two, 1e-9), 'two half steps land exactly where one whole step does');
}
ok(rampToward(0.5, 1, 0, 26) === 0.5, 'a zero-length frame moves nothing');
ok(rampToward(0.5, 1, 0.016, 0) === 1, 'a zero rate snaps instead of freezing');
ok(rampToward(NaN, 1, 0.016, 26) > 0, 'a NaN current is treated as off, not propagated');
ok(rampToward(0.99999, 1, 0.016, 26) === 1, 'it settles exactly on the target instead of creeping forever');

// ---- colour ----
ok(flashlightColor(0) === ((Math.round(WEAPON_LIGHT_COOL[0] * 255) << 16) | (Math.round(WEAPON_LIGHT_COOL[1] * 255) << 8) | Math.round(WEAPON_LIGHT_COOL[2] * 255)),
  'warmth 0 is the authored cool white');
{
  const cool = new THREE.Color(flashlightColor(0)), warm = new THREE.Color(flashlightColor(1)), mid = new THREE.Color(flashlightColor(0.5));
  ok(warm.r > cool.r && warm.b < cool.b, 'warm has more red and less blue than cool');
  ok(mid.r > cool.r && mid.r < warm.r, 'the middle sits between them');
}
ok(flashlightColor(-5) === flashlightColor(0) && flashlightColor(9) === flashlightColor(1), 'warmth outside 0..1 clamps');

// ---- cone angle ----
ok(near(coneAngleRad(90), coneAngleRad(80)), 'a spot angle past 80 degrees clamps: THREE misbehaves at the limit');
ok(near(coneAngleRad(0), coneAngleRad(1)), 'and a zero-width cone clamps to something that still lights');
ok(near(coneAngleRad(45), Math.PI / 4), '45 degrees is a quarter pi');

// ---- placement ----
{
  const pos = [0, 0, 0], tgt = [0, 0, 0];
  const out = placeFlashlight([1, 2, 3], [0, 0, -1], null, pos, tgt);
  ok(out === pos, 'placeFlashlight writes into the caller-supplied arrays');
  ok(near(pos[2], 3 - WEAPON_LIGHT_DEFAULTS.lensForward), 'the lamp sits just ahead of the muzzle, clear of the barrel');
  ok(near(pos[0], 1) && near(pos[1], 2), 'and stays on the bore line');
  ok(near(tgt[2], pos[2] - WEAPON_LIGHT_DEFAULTS.targetDistance), 'the aim point is straight down the bore');
  // An unnormalized direction must not stretch the offsets.
  placeFlashlight([0, 0, 0], [0, 0, -20], null, pos, tgt);
  ok(near(pos[2], -WEAPON_LIGHT_DEFAULTS.lensForward), 'a long direction vector is normalized first');
  ok(placeFlashlight([0, 0, 0], [0, 0, 0], null, pos, tgt) === null, 'a zero direction has no bore to sit on');
  ok(placeFlashlight(null, [0, 0, -1], null, pos, tgt) === null && placeFlashlight([0, 0, 0], null, null, pos, tgt) === null, 'a missing muzzle or direction yields nothing');
  placeFlashlight([0, 0, 0], [0, 0, -1], { lensForward: 0, targetDistance: 5 }, pos, tgt);
  ok(near(pos[2], 0) && near(tgt[2], -5), 'the offsets are overridable');
}

// ---- the lights ----
const scene = new THREE.Scene();
const light = createWeaponLight({ THREE, scene });
ok(light.light.isSpotLight && light.spill.isPointLight, 'the beam is a real SpotLight and the spill a real PointLight');
ok(light.light.parent === scene && light.light.target.parent === scene && light.spill.parent === scene, 'both lights and the spot target live in the scene');
ok(light.light.intensity === 0 && light.spill.intensity === 0 && light.on === false, 'it starts off, at intensity 0 rather than hidden');
ok(light.light.visible !== false && light.spill.visible !== false, 'visibility is never used as the switch (WebGPU pipeline-hash rule)');
ok(light.light.castShadow === false, 'shadows are off by default: a second shadow pass is the expensive part');

const source = { muzzle: [0, 1.5, 0], direction: [0, 0, -1] };
light.update(1 / 60, source);
ok(light.light.intensity === 0, 'with the switch off, having a gun in hand lights nothing');
light.setOn(true);
light.update(1, source);
ok(light.light.intensity > 0 && light.spill.intensity > 0, 'switching on brings both lights up');
ok(light.light.intensity === WEAPON_LIGHT_DEFAULTS.intensity, 'and after a full second it is at the configured brightness');
ok(near(light.light.position.z, -WEAPON_LIGHT_DEFAULTS.lensForward) && near(light.light.position.y, 1.5), 'the lamp is on the muzzle');
ok(light.spill.position.equals(light.light.position), 'the spill sits at the lens, not somewhere else');
ok(light.light.target.position.z < light.light.position.z, 'the spot aims down the bore');

// Turning while lit: the light follows the gun, not the camera, so the page can hand it a new bore.
light.update(1 / 60, { muzzle: [3, 1.5, 0], direction: [1, 0, 0] });
ok(near(light.light.position.x, 3 + WEAPON_LIGHT_DEFAULTS.lensForward), 'the lamp tracks the muzzle each frame');
ok(light.light.target.position.x > light.light.position.x, 'and re-aims with it');

// No mount (a knife, a death, a menu): fade, do not blink.
const before = light.light.intensity;
light.update(1 / 120, null);
ok(light.light.intensity < before && light.light.intensity > 0, 'losing the source ramps down rather than cutting to black');
light.update(2, null);
ok(light.light.intensity === 0 && light.spill.intensity === 0, 'and settles at zero');

// Configure.
light.configure({ intensity: 900, range: 120, angleDeg: 40, penumbra: 0.2, warmth: 1, spillIntensity: 0, shadows: true });
ok(light.light.distance === 120 && near(light.light.angle, coneAngleRad(40)) && light.light.penumbra === 0.2, 'configure pushes range, angle and softness through');
ok(light.light.castShadow === true && light.light.shadow.camera.far === 120, 'turning shadows on also moves the shadow camera out to the new range');
ok(near(light.light.color.r, new THREE.Color(flashlightColor(1)).r), 'and the colour follows the warmth');
light.update(1, source);
ok(light.light.intensity === 900 && light.spill.intensity === 0, 'a zero spill is off while the beam stays lit');
ok(light.toggle() === false, 'toggle flips the switch');
light.update(1, source);
ok(light.light.intensity === 0, 'and switching off puts the beam out');

light.dispose();
ok(scene.children.every(c => !c.isSpotLight && !c.isPointLight), 'dispose removes both lights');
ok((() => { try { createWeaponLight({ scene: new THREE.Scene() }); return false; } catch { return true; } })(), 'it refuses to run without THREE');
ok((() => { try { createWeaponLight({ THREE }); return false; } catch { return true; } })(), 'and without a scene');

// ---- wiring ----
{
  const html = readFileSync(new URL('./base-game.html', import.meta.url), 'utf8');
  const markers = ['weapon-light.js', 'createWeaponLight(', 'weaponLight.update(', 'weaponLightSource(', 'applyFlashlight(',
    "event.code === 'KeyL'", "'flashlightOn'", "'flashlightShadows'", 'barrelDirection('];
  for (const marker of markers) ok(html.includes(marker), `base-game.html wires ${marker}`);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
