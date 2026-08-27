// weapon-laser.js — a laser sight on the weapon bore: a beam and the dot it puts on the surface.
//
// The companion to weapon-light.js, and deliberately the opposite kind of thing. A flashlight is a
// light, so it is a real SpotLight and nothing is drawn. A laser is not a light — what you see is a
// thin column of air scattering it and a bright spot where it lands, so this one IS drawn: a beam
// mesh from the muzzle to the hit, and a dot with a hot core and a coloured halo.
//
// Two details do most of the work:
//
//   1. **Both are floored in SCREEN pixels, not metres.** A 6 mm beam is a quarter of a pixel at
//      40 m, which shimmers in and out along its length instead of reading as a line. Every frame
//      the width and the dot radius are widened to whatever the authored minimum pixel size costs
//      at that depth, so the laser looks the same at arm's length and across a valley.
//   2. **The dot sits on the surface, not on a billboard**, when the raycast gave a normal — a
//      laser spot on a sloped wall is an ellipse, and a camera-facing disc reads as a HUD marker.
//      Without a normal it falls back to facing the camera.
//
// The page owns the raycast (it has the world query and the coordinate rebasing) and hands the hit
// distance in. The geometry helpers are pure and unit-tested in test-weapon-laser.mjs.
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { rampToward } from './weapon-light.js';

export const WEAPON_LASER_DEFAULTS = Object.freeze({
  hue: 0,                // 0 red, 1/3 green — the two colours real sights come in
  beamWidth: 0.005,      // metres, before the pixel floor below
  beamMinPixels: 1.5,
  beamOpacity: 0.32,     // a beam you can see through: a solid rod reads as a laser POINTER prop
  dotRadius: 0.012,
  dotMinPixels: 3.5,
  haloScale: 2.6,        // the halo, as a multiple of the core
  haloOpacity: 0.5,
  maxRange: 120,
  surfaceOffset: 0.012,  // metres along the normal, so the dot does not z-fight the wall
  rampRate: 40,          // faster than the flashlight: a diode has no filament to warm up
  beamVisible: true,
});

// Metres per pixel, per metre of depth. Multiply by a distance to get the world size of one pixel
// at that distance.
export function metresPerPixel(fovYDeg, viewportHeight) {
  const fov = Math.max(1, Math.min(179, Number(fovYDeg) || 50));
  const height = Math.max(1, Number(viewportHeight) || 1);
  return 2 * Math.tan(fov * Math.PI / 360) / height;
}

// The authored world size, or whatever `minPixels` costs at this depth — whichever is larger.
export function screenSizeFloor(worldSize, distance, perPixel, minPixels) {
  const world = Math.max(0, Number(worldSize) || 0);
  const d = Math.max(0, Number(distance) || 0);
  const mpp = Math.max(0, Number(perPixel) || 0);
  const px = Math.max(0, Number(minPixels) || 0);
  return Math.max(world, d * mpp * px);
}

// Where the beam ends: the hit if there was one, else the full range. Writes `out`, returns length.
export function laserEnd(muzzle, direction, hitDistance, maxRange, out) {
  if (!muzzle || !direction) return 0;
  const len = Math.hypot(direction[0], direction[1], direction[2]);
  if (!(len > 1e-6)) return 0;
  const range = Math.max(0, Number(maxRange) || 0);
  // `hitDistance == null` is "the ray hit nothing". Not Number(null), which is a finite 0 and would
  // collapse the beam to a point every time you pointed at the sky.
  const hit = hitDistance == null ? NaN : Number(hitDistance);
  const distance = Number.isFinite(hit) && hit >= 0 ? Math.min(hit, range) : range;
  out[0] = muzzle[0] + direction[0] / len * distance;
  out[1] = muzzle[1] + direction[1] / len * distance;
  out[2] = muzzle[2] + direction[2] / len * distance;
  return distance;
}

// Fully saturated hue to a packed hex, so a hue slider is the whole colour control.
export function hueToHex(hue) {
  const h = ((Number(hue) || 0) % 1 + 1) % 1;
  const f = (n) => {
    const k = (n + h * 6) % 6;
    return Math.round((1 - Math.max(0, Math.min(1, Math.min(k, 4 - k, 1)))) * 255);
  };
  return (f(5) << 16) | (f(3) << 8) | f(1);
}

// One key, two switches. The laser has no key of its own, so a tap is told from a double tap by the
// gap between them. `lastTapMs` may be null or -Infinity for "no previous tap".
export const DOUBLE_TAP_MS = 280;
export function tapKind(lastTapMs, nowMs, windowMs = DOUBLE_TAP_MS) {
  const now = Number(nowMs) || 0;
  // Not `Number(null)`: that is 0, which is finite, so "never tapped" would read as a tap at time 0.
  if (lastTapMs == null) return 'single';
  const last = Number(lastTapMs);
  if (!Number.isFinite(last)) return 'single';
  const gap = now - last;
  return gap >= 0 && gap <= Math.max(0, Number(windowMs) || 0) ? 'double' : 'single';
}

export function createWeaponLaser({ THREE, scene, options = null } = {}) {
  if (!THREE?.Mesh) throw new TypeError('createWeaponLaser needs THREE');
  if (!scene) throw new TypeError('createWeaponLaser needs a scene');
  const cfg = { ...WEAPON_LASER_DEFAULTS, ...(options || {}) };

  const additive = (opacity) => new MeshBasicNodeMaterial({
    color: hueToHex(cfg.hue), transparent: true, opacity, depthWrite: false,
    blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide, fog: false,
  });

  // Open-ended unit cylinder growing from the origin along +Y, so the instance transform is just
  // "point it down the bore and scale it to the hit".
  const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true).translate(0, 0.5, 0);
  const beam = new THREE.Mesh(beamGeo, additive(cfg.beamOpacity));
  beam.name = 'weaponLaserBeam';
  beam.frustumCulled = false;   // it is scaled per frame; a stale bounding sphere pops it off screen
  beam.visible = false;

  const dotGeo = new THREE.CircleGeometry(1, 20);
  // The core reads white because it is the halo's colour added on top of itself; a laser spot is
  // over-exposed at the centre and coloured only at the edge.
  const core = new THREE.Mesh(dotGeo, additive(1));
  core.name = 'weaponLaserDot';
  const halo = new THREE.Mesh(dotGeo, additive(cfg.haloOpacity));
  halo.name = 'weaponLaserHalo';
  for (const mesh of [core, halo]) { mesh.frustumCulled = false; mesh.visible = false; }
  scene.add(beam, halo, core);

  const _end = [0, 0, 0];
  const _dir = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _forward = new THREE.Vector3(0, 0, 1);
  const _point = new THREE.Vector3(), _mid = new THREE.Vector3(), _normal = new THREE.Vector3(), _camera = new THREE.Vector3();
  let on = false, level = 0, placed = false;

  function applyColor() {
    const hex = hueToHex(cfg.hue);
    beam.material.color.setHex(hex);
    core.material.color.setHex(hex);
    halo.material.color.setHex(hex);
  }

  function configure(patch) {
    if (!patch) return cfg;
    Object.assign(cfg, patch);
    applyColor();
    return cfg;
  }

  function setOn(next) { on = !!next; return on; }
  function toggle() { return setOn(!on); }

  function hide() {
    if (beam.visible) beam.visible = false;
    if (core.visible) { core.visible = false; halo.visible = false; }
  }

  // source: { muzzle, direction, hitDistance, normal } in scene space, or null when there is
  // nothing to mount to. view: { cameraPosition, metresPerPixel } for the screen-size floors.
  function applyOpacity() {
    beam.material.opacity = cfg.beamOpacity * level;
    core.material.opacity = level;
    halo.material.opacity = cfg.haloOpacity * level;
  }

  function update(dt, source, view) {
    const usable = !!(source?.muzzle && source?.direction);
    level = rampToward(level, on && usable ? 1 : 0, dt, cfg.rampRate);
    if (level <= 0.002) { hide(); return level; }
    // Holstering mid-stride leaves nowhere to draw the beam, but cutting it that frame is a blink.
    // Hold the last placement and fade it out from there, the way the flashlight fades in place.
    if (!usable) { if (placed) applyOpacity(); return level; }
    const length = laserEnd(source.muzzle, source.direction, source.hitDistance, cfg.maxRange, _end);
    if (!(length > 0)) { if (placed) applyOpacity(); return level; }

    const perPixel = Number(view?.metresPerPixel) || 0;
    const cam = view?.cameraPosition;
    if (cam) _camera.set(cam[0] ?? cam.x ?? 0, cam[1] ?? cam.y ?? 0, cam[2] ?? cam.z ?? 0);
    _point.set(_end[0], _end[1], _end[2]);
    const dotDepth = cam ? _camera.distanceTo(_point) : 0;

    // Beam: from the muzzle, down the bore, ending at the hit. Its width is floored at the depth of
    // its own MIDPOINT — using the far end would fatten the near half into a cone.
    _dir.set(source.direction[0], source.direction[1], source.direction[2]).normalize();
    if (cfg.beamVisible) {
      beam.position.set(source.muzzle[0], source.muzzle[1], source.muzzle[2]);
      beam.quaternion.setFromUnitVectors(_up, _dir);
      const midDepth = cam ? _camera.distanceTo(_mid.copy(_point).addScaledVector(_dir, -length * 0.5)) : 0;
      const width = screenSizeFloor(cfg.beamWidth, midDepth, perPixel, cfg.beamMinPixels);
      beam.scale.set(width, length, width);
      if (!beam.visible) beam.visible = true;
    } else if (beam.visible) beam.visible = false;

    // Dot: on the surface when the raycast gave a normal, else facing the camera.
    const radius = screenSizeFloor(cfg.dotRadius, dotDepth, perPixel, cfg.dotMinPixels);
    core.position.copy(_point);
    let oriented = false;
    if (source.normal) {
      _normal.set(source.normal[0], source.normal[1], source.normal[2]);
      if (_normal.lengthSq() > 1e-8) {
        _normal.normalize();
        core.quaternion.setFromUnitVectors(_forward, _normal);
        core.position.addScaledVector(_normal, cfg.surfaceOffset);
        oriented = true;
      }
    }
    if (!oriented && cam) core.lookAt(_camera);
    core.scale.setScalar(radius);
    halo.position.copy(core.position);
    halo.quaternion.copy(core.quaternion);
    halo.scale.setScalar(radius * cfg.haloScale);
    applyOpacity();
    if (!core.visible) { core.visible = true; halo.visible = true; }
    placed = true;
    return level;
  }

  function dispose() {
    scene.remove(beam, core, halo);
    beamGeo.dispose();
    dotGeo.dispose();
    for (const mesh of [beam, core, halo]) mesh.material.dispose();
  }

  return {
    beam, core, halo, configure, setOn, toggle, update, dispose,
    get on() { return on; },
    get level() { return level; },
    get config() { return cfg; },
  };
}
