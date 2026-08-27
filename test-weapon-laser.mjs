// weapon-laser.js: the laser sight. Headless — a real THREE scene, no renderer. The screen-size
// floors and the double-tap discrimination are pure; the meshes are checked through the module.
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import {
  createWeaponLaser, laserEnd, metresPerPixel, screenSizeFloor, hueToHex, tapKind,
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

// ---- screen-size floors ----
{
  const mpp = metresPerPixel(50, 900);
  ok(mpp > 0 && near(mpp, 2 * Math.tan(50 * Math.PI / 360) / 900), 'metres per pixel is the vertical FOV over the viewport height');
  ok(metresPerPixel(20, 900) < mpp, 'zooming in makes each pixel cover less world');
  ok(metresPerPixel(50, 1800) < mpp, 'and so does a taller window');
  ok(metresPerPixel(0, 0) > 0 && Number.isFinite(metresPerPixel(NaN, NaN)), 'nonsense inputs still give a finite scale');
}
ok(screenSizeFloor(0.005, 1, 0.001, 1.5) === 0.005, 'up close the authored world width wins');
{
  // 40 m out, a 5 mm beam is a fraction of a pixel; the floor is what stops it shimmering.
  const mpp = metresPerPixel(50, 900);
  const wide = screenSizeFloor(0.005, 40, mpp, 1.5);
  ok(wide > 0.005, 'far away the pixel floor takes over');
  ok(near(wide, 40 * mpp * 1.5), 'and the width is exactly the requested pixel count at that depth');
  ok(screenSizeFloor(0.005, 80, mpp, 1.5) > wide, 'twice as far is twice as wide in world units, so it holds still on screen');
}
ok(screenSizeFloor(0.01, 40, 0, 3) === 0.01, 'with no pixel scale the floor cannot apply');
ok(screenSizeFloor(-1, -1, -1, -1) === 0, 'negatives are clamped rather than inverting the beam');

// ---- the beam segment ----
{
  const out = [0, 0, 0];
  ok(laserEnd([0, 1, 0], [0, 0, -1], 12, 120, out) === 12 && near(out[2], -12), 'a hit ends the beam at the hit');
  ok(laserEnd([0, 1, 0], [0, 0, -1], null, 120, out) === 120 && near(out[2], -120), 'no hit runs to the full range');
  ok(laserEnd([0, 1, 0], [0, 0, -1], 500, 120, out) === 120, 'a hit past the range is clipped to the range');
  ok(laserEnd([0, 1, 0], [0, 0, -4], 12, 120, out) === 12 && near(out[2], -12), 'the direction is normalized, so its length cannot stretch the beam');
  ok(laserEnd([0, 1, 0], [0, 0, 0], 12, 120, out) === 0, 'a zero direction has no beam');
  ok(laserEnd(null, [0, 0, -1], 12, 120, out) === 0 && laserEnd([0, 0, 0], null, 12, 120, out) === 0, 'a missing muzzle or direction yields nothing');
}

// ---- colour ----
ok(hueToHex(0) === 0xff0000, 'hue 0 is red');
ok(hueToHex(1 / 3) === 0x00ff00, 'a third round is green');
ok(hueToHex(2 / 3) === 0x0000ff, 'two thirds is blue');
ok(hueToHex(1) === hueToHex(0) && hueToHex(-1 / 3) === hueToHex(2 / 3), 'the wheel wraps in both directions');

// ---- the meshes ----
const scene = new THREE.Scene();
const laser = createWeaponLaser({ THREE, scene });
ok(laser.beam.isMesh && laser.core.isMesh && laser.halo.isMesh, 'the laser is a beam, a hot core and a halo');
ok([laser.beam, laser.core, laser.halo].every(m => m.parent === scene && m.visible === false), 'all three are in the scene and start hidden');
ok([laser.beam, laser.core, laser.halo].every(m => m.frustumCulled === false), 'none is frustum-culled: they are re-scaled per frame, so a cached bounding sphere is a lie');
ok(laser.core.material.depthWrite === false && laser.core.material.toneMapped === false, 'the dot is additive and skips tone mapping, so it stays saturated');
ok(laser.on === false, 'and it starts switched off');

const view = { cameraPosition: [0, 1.5, 5], metresPerPixel: metresPerPixel(50, 900) };
const source = { muzzle: [0, 1.5, 0], direction: [0, 0, -1], hitDistance: 10, normal: [0, 0, 1] };
laser.update(1 / 60, source, view);
ok(laser.beam.visible === false, 'switched off, a gun and a wall still draw nothing');

laser.setOn(true);
laser.update(1, source, view);
ok(laser.beam.visible && laser.core.visible && laser.halo.visible, 'switching on shows all three');
ok(near(laser.beam.position.z, 0) && near(laser.beam.scale.y, 10), 'the beam starts at the muzzle and is exactly as long as the shot is');
ok(near(laser.core.position.z, -10 + WEAPON_LASER_DEFAULTS.surfaceOffset), 'the dot sits on the surface, lifted off it by the z-fight offset');
ok(laser.halo.scale.x > laser.core.scale.x, 'the halo is bigger than the core');
ok(near(laser.halo.position.z, laser.core.position.z), 'and sits on it');
ok(laser.core.material.opacity > 0.99, 'at full ramp the core is at full strength');

// The dot takes the surface's orientation when there is one, and faces the camera when there is not.
{
  const onWall = laser.core.quaternion.clone();
  laser.update(1, { ...source, normal: [1, 0, 0] }, view);
  ok(!laser.core.quaternion.equals(onWall), 'a differently angled surface turns the dot');
  laser.update(1, { ...source, normal: null }, view);
  const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(laser.core.quaternion);
  const toCam = new THREE.Vector3(0, 1.5, 5).sub(laser.core.position).normalize();
  ok(facing.dot(toCam) > 0.999, 'with no normal the dot billboards to the camera');
  laser.update(1, { ...source, normal: [0, 0, 0] }, view);
  ok(Number.isFinite(laser.core.position.x), 'a degenerate normal does not produce NaN');
}

// The pixel floors, through the module: the same dot further away is bigger in world units.
{
  laser.update(1, source, view);
  const nearDot = laser.core.scale.x, nearBeam = laser.beam.scale.x;
  laser.update(1, { ...source, hitDistance: 80 }, view);
  ok(laser.core.scale.x > nearDot, 'a dot 80 m out is scaled up so it does not vanish');
  ok(laser.beam.scale.x > nearBeam, 'and so is the beam');
  ok(near(laser.beam.scale.y, 80), 'while its length still tracks the hit');
}

// No hit: the beam runs out to the configured range rather than disappearing.
laser.update(1, { muzzle: [0, 1.5, 0], direction: [0, 0, -1], hitDistance: null, normal: null }, view);
ok(near(laser.beam.scale.y, WEAPON_LASER_DEFAULTS.maxRange), 'pointing at the sky draws the beam to its full range');

// Losing the mount fades rather than blinking, like the flashlight.
laser.update(1 / 240, null, view);
ok(laser.beam.visible, 'one frame without a source has not put it out yet');
laser.update(1, null, view);
ok(laser.beam.visible === false && laser.core.visible === false, 'and then it goes away');

// Configure.
laser.configure({ hue: 1 / 3, beamVisible: false, maxRange: 30, beamOpacity: 0.8 });
ok(laser.core.material.color.getHex() === 0x00ff00 && laser.beam.material.color.getHex() === 0x00ff00, 'the hue reaches every part');
laser.update(1, source, view);
ok(laser.beam.visible === false && laser.core.visible === true, 'the beam can be turned off while the dot stays');
ok(laser.toggle() === false, 'toggle flips the switch');
laser.update(1, source, view);
ok(laser.core.visible === false, 'and switching off clears the dot');

laser.dispose();
ok(scene.children.length === 0, 'dispose removes all three meshes');
ok((() => { try { createWeaponLaser({ scene: new THREE.Scene() }); return false; } catch { return true; } })(), 'it refuses to run without THREE');
ok((() => { try { createWeaponLaser({ THREE }); return false; } catch { return true; } })(), 'and without a scene');

// ---- wiring ----
{
  const html = readFileSync(new URL('./base-game.html', import.meta.url), 'utf8');
  const markers = ['weapon-laser.js', 'createWeaponLaser(', 'updateWeaponLaser(', 'applyLaser(', 'tapKind(',
    'lastLightTapMs', "'laserOn'", "'laserBeam'", 'metresPerPixel(', 'worldQuery.raycast('];
  for (const marker of markers) ok(html.includes(marker), `base-game.html wires ${marker}`);
  // The laser must not pay for a raycast it is not drawing.
  ok(html.includes('!source || !settings.laserOn'), 'the extra raycast is gated on the laser actually being on');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
