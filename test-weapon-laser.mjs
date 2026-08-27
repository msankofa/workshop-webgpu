// weapon-laser.js: the laser sight. Headless — a real THREE scene, no renderer. The dot is a real
// SpotLight, so most of what matters here is that the light is configured the way a collimated beam
// actually behaves; the only drawn part is the beam in the air.
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import {
  createWeaponLaser, metresPerPixel, screenSizeFloor, dotAngleRad, hueToHex, tapKind,
  WEAPON_LASER_DEFAULTS, DOUBLE_TAP_MS,
} from './weapon-laser.js';

let pass = 0, fail = 0;
const ok = (condition, message) => { if (condition) pass++; else { fail++; console.error('FAIL:', message); } };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---- one key, two switches ----
ok(tapKind(null, 1000) === 'single', 'the first tap of a session is a single');
ok(tapKind(undefined, 1000) === 'single', 'and so is one with no clock at all');
// Number(null) is 0, which is finite: without an explicit guard "never tapped" reads as a tap at 0.
ok(tapKind(null, 100) === 'single', 'a null clock is not treated as a tap at time zero');
ok(tapKind(1000, 1000 + DOUBLE_TAP_MS - 1) === 'double', 'a second tap inside the window is a double');
ok(tapKind(1000, 1000 + DOUBLE_TAP_MS) === 'double', 'exactly on the window still counts');
ok(tapKind(1000, 1000 + DOUBLE_TAP_MS + 1) === 'single', 'a beat later is two singles');
ok(tapKind(1000, 900) === 'single', 'a clock that went backwards does not fire a double');
ok(tapKind(1000, 1100, 20) === 'single' && tapKind(1000, 1010, 20) === 'double', 'the window is overridable');

// ---- the cone ----
ok(near(dotAngleRad(0.2), 0.2 * Math.PI / 180), 'the dot angle is a half-angle in radians');
ok(dotAngleRad(0) === dotAngleRad(0.01), 'a zero cone clamps to something that still lights');
ok(dotAngleRad(90) === dotAngleRad(45), 'and it clamps before it stops being a dot');
ok(dotAngleRad(NaN) === dotAngleRad(0.01), 'nonsense is treated as the minimum, not NaN');

// ---- colour ----
ok(hueToHex(0) === 0xff0000, 'hue 0 is red');
ok(hueToHex(1 / 3) === 0x00ff00, 'a third round is green');
ok(hueToHex(2 / 3) === 0x0000ff, 'two thirds is blue');
ok(hueToHex(1) === hueToHex(0) && hueToHex(-1 / 3) === hueToHex(2 / 3), 'the wheel wraps in both directions');

// ---- the beam's screen-width floor ----
{
  const mpp = metresPerPixel(50, 900);
  ok(mpp > 0 && near(mpp, 2 * Math.tan(50 * Math.PI / 360) / 900), 'metres per pixel is the vertical FOV over the viewport height');
  ok(metresPerPixel(20, 900) < mpp, 'zooming in makes each pixel cover less world');
  ok(metresPerPixel(50, 1800) < mpp, 'and so does a taller window');
  ok(metresPerPixel(0, 0) > 0 && Number.isFinite(metresPerPixel(NaN, NaN)), 'nonsense inputs still give a finite scale');
  ok(screenSizeFloor(0.005, 1, mpp, 1.5) === 0.005, 'up close the authored world width wins');
  const wide = screenSizeFloor(0.005, 40, mpp, 1.5);
  ok(wide > 0.005 && near(wide, 40 * mpp * 1.5), 'far away the beam is widened to exactly the requested pixel count');
  ok(screenSizeFloor(0.005, 80, mpp, 1.5) > wide, 'twice as far is twice as wide in world units, so it holds still on screen');
}
ok(screenSizeFloor(0.01, 40, 0, 3) === 0.01, 'with no pixel scale the floor cannot apply');
ok(screenSizeFloor(-1, -1, -1, -1) === 0, 'negatives are clamped rather than inverting the beam');

// ---- the dot is a light ----
const scene = new THREE.Scene();
const laser = createWeaponLaser({ THREE, scene });
ok(laser.spot.isSpotLight, 'the dot is a real SpotLight, not a drawn quad');
ok(laser.spot.parent === scene && laser.spot.target.parent === scene, 'the light and its target live in the scene');
ok(laser.spot.decay === 0, 'decay is zero: a collimated beam does not spread, so the dot is as bright far as near');
ok(laser.spot.distance === WEAPON_LASER_DEFAULTS.range, 'a cutoff distance is still set, which is what fades the dot out at the end of its range');
ok(laser.spot.angle < 0.02, 'the cone is a fraction of a degree, so it reads as a dot rather than a torch');
// three's cone falloff is smoothstep(coneCos, penumbraCos, angleCos); penumbra 0 makes those edges
// equal, which is degenerate, and a hard edge on a 4-pixel dot crawls as you turn.
ok(laser.spot.penumbra > 0, 'the cone always has some penumbra');
ok(laser.spot.castShadow === true, 'shadows default ON: without them the dot also lands on the wall behind the one it hit');
ok(laser.spot.intensity === 0 && laser.on === false, 'it starts off, at intensity 0 rather than hidden');
ok(laser.spot.visible !== false, 'visibility is never used as the switch (WebGPU pipeline-hash rule)');
ok(laser.beam.isMesh && laser.beam.visible === false && laser.beam.frustumCulled === false,
  'the beam is a mesh, starts hidden, and is never frustum-culled: it is re-scaled every frame');
ok(laser.beam.material.depthWrite === false, 'the beam does not write depth, so it cannot occlude what is behind it');

const view = { cameraPosition: [0, 1.5, 5], metresPerPixel: metresPerPixel(50, 900) };
const source = { muzzle: [0, 1.5, 0], direction: [0, 0, -1] };
laser.update(1 / 60, source, view);
ok(laser.spot.intensity === 0 && laser.beam.visible === false, 'switched off, a gun in hand lights nothing');

laser.setOn(true);
laser.update(1, source, view);
ok(laser.spot.intensity === WEAPON_LASER_DEFAULTS.intensity, 'switching on brings the dot up to its configured brightness');
ok(near(laser.spot.position.z, 0) && near(laser.spot.position.y, 1.5), 'the emitter sits at the muzzle');
ok(laser.spot.target.position.z < laser.spot.position.z, 'and aims down the bore');
ok(laser.beam.visible && near(laser.beam.scale.y, WEAPON_LASER_DEFAULTS.range),
  'the beam is drawn to the full range: depth testing clips it at whatever it runs into, so it needs no raycast');

// Turning: everything follows the gun, not the camera.
laser.update(1 / 60, { muzzle: [3, 1.5, 0], direction: [1, 0, 0] }, view);
ok(near(laser.spot.position.x, 3), 'the emitter tracks the muzzle each frame');
ok(laser.spot.target.position.x > laser.spot.position.x, 'and re-aims with it');

// The beam width is floored on screen; the dot is a light and has no drawn size to floor.
{
  laser.configure({ range: 10 });
  laser.update(1, source, view);
  const nearBeam = laser.beam.scale.x;
  laser.configure({ range: 200 });
  laser.update(1, source, view);
  ok(laser.beam.scale.x > nearBeam, 'a beam stretching further away is widened so its far end does not thin to nothing');
  ok(near(laser.beam.scale.y, 200), 'while its length is the range');
  laser.configure({ range: WEAPON_LASER_DEFAULTS.range });
}

// Losing the mount fades rather than blinking.
laser.update(1, source, view);
laser.update(1 / 240, null, view);
ok(laser.spot.intensity > 0 && laser.spot.intensity < WEAPON_LASER_DEFAULTS.intensity, 'one frame without a source has dimmed it, not cut it');
ok(laser.beam.visible, 'and the beam is still there');
laser.update(1, null, view);
ok(laser.spot.intensity === 0 && laser.beam.visible === false, 'and then it goes out');
ok(laser.placed === true, 'the last placement is remembered, which is what let it fade in place');

// Configure.
laser.configure({ hue: 1 / 3, dotAngleDeg: 1, intensity: 90, range: 30, shadows: false, beamVisible: false });
ok(laser.spot.color.getHex() === 0x00ff00 && laser.beam.material.color.getHex() === 0x00ff00, 'the hue reaches the light and the beam');
ok(near(laser.spot.angle, dotAngleRad(1)) && laser.spot.distance === 30, 'the cone and the range are pushed through');
ok(laser.spot.castShadow === false && laser.spot.shadow.camera.far === 30, 'shadows can be turned off, and the shadow camera follows the range');
laser.update(1, source, view);
ok(laser.spot.intensity === 90 && laser.beam.visible === false, 'the beam can be turned off while the dot stays lit');
ok(laser.toggle() === false, 'toggle flips the switch');
laser.update(1, source, view);
ok(laser.spot.intensity === 0, 'and switching off puts the dot out');

// A degenerate bore must not produce NaN in the light transform.
laser.setOn(true);
laser.update(1, { muzzle: [1, 2, 3], direction: [0, 0, 0] }, view);
ok(Number.isFinite(laser.spot.position.x) && Number.isFinite(laser.spot.target.position.x), 'a zero direction leaves the transform finite');

laser.dispose();
ok(scene.children.every(c => !c.isSpotLight && !c.isMesh), 'dispose removes the light and the beam');
ok((() => { try { createWeaponLaser({ scene: new THREE.Scene() }); return false; } catch { return true; } })(), 'it refuses to run without THREE');
ok((() => { try { createWeaponLaser({ THREE }); return false; } catch { return true; } })(), 'and without a scene');

// ---- wiring ----
{
  const html = readFileSync(new URL('./base-game.html', import.meta.url), 'utf8');
  const markers = ['weapon-laser.js', 'createWeaponLaser(', 'updateWeaponLaser(', 'applyLaser(', 'tapKind(',
    'lastLightTapMs', "'laserOn'", "'laserBeam'", "'laserShadows'", 'metresPerPixel('];
  for (const marker of markers) ok(html.includes(marker), `base-game.html wires ${marker}`);
  // The whole point of the rebuild: the laser no longer costs a world query per frame.
  const body = html.slice(html.indexOf('function updateWeaponLaser'));
  ok(!body.slice(0, body.indexOf('\n}')).includes('raycast'), 'the laser takes no ray of its own');
  ok(!html.includes('laserDotPixels') && !html.includes('_laserSource'), 'and the drawn-dot settings and scratch are gone');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
