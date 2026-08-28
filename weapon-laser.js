// weapon-laser.js — a laser sight on the weapon bore.
//
// The dot is a REAL LIGHT: a SpotLight with a cone a fraction of a degree wide and `decay: 0`.
// Zero decay is not a cheat, it is what a laser is — a collimated beam does not spread, so its
// irradiance does not fall off with distance, and three's own `getDistanceAttenuation` reduces to a
// constant 1 at decay 0 while the Frostbite window still fades it out at the end of `range`. So the
// dot is the same brightness at two metres and at eighty, which is the actual behaviour.
//
// Everything a light gives for free is the reason to do it this way rather than draw a quad where a
// raycast said the surface was: the dot lands on whatever is really there (including anything the
// world query has no provider for), wraps over edges and curves, takes the surface's own material
// response, and needs no ray of its own. The version this replaced raycast the world every frame and
// pasted a billboard at the hit — which put the dot on the terrain *behind* a player rather than on
// them, because the query does not know about bodies.
//
// The BEAM is the one part a light cannot express — no light source draws a visible column of air —
// so that stays a mesh. It needs no raycast either: it is drawn to the full range with depth testing
// on, so opaque geometry clips it exactly where the beam would stop.
//
// Its radius is a plain world measurement with nothing layered on top, so 0 means 0 and the beam is
// hidden rather than drawn at zero scale. An earlier version also floored the radius in screen
// pixels so the far end could not go sub-pixel; that floor was computed at the beam's midpoint,
// which over a 120 m beam is 60 m away, so it swamped the whole sensible part of the radius slider —
// 0 mm, 1 mm and 5 mm all drew the same 10 cm tube. A beam genuinely does thin out with distance;
// that is what distance looks like, and it is not worth a control that overrides the control.
//
// Two things about the cone are load-bearing:
//   * `penumbra` is never 0. three's cone falloff is `smoothstep(coneCos, penumbraCos, angleCos)`,
//     and penumbra 0 makes those two edges equal, which is degenerate. It also anti-aliases a dot
//     that is only a few pixels across, which otherwise crawls and sparkles as you turn.
//   * `shadows` defaults ON, unlike the flashlight's. A spot lights every surface inside its cone,
//     so without a shadow map the dot appears on the wall BEHIND the pillar it just landed on —
//     two dots. The saving grace is that the shadow frustum is under a degree wide, so even a small
//     map is enormous angular resolution.
//
// The geometry helpers are pure and unit-tested in test-weapon-laser.mjs.
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { rampToward } from './weapon-light.js';

export const WEAPON_LASER_DEFAULTS = Object.freeze({
  hue: 0,                // 0 red, 1/3 green — the two colours real sights come in
  dotAngleDeg: 0.2,      // HALF-angle of the cone: how wide the dot is, seen from the muzzle
  penumbra: 0.4,         // never 0 — see the note above
  intensity: 30,
  decay: 0,              // collimated: a laser does not spread, so it does not dim with distance
  range: 120,
  shadows: true,         // without it the dot also lands on whatever is behind the wall it hit
  shadowMapSize: 512,
  beamVisible: true,
  beamRadius: 0.0025,    // metres, and nothing overrides it: 0 means 0
  beamOpacity: 0.3,      // a beam you can see through: a solid rod reads as a laser POINTER prop
  rampRate: 40,          // faster than the flashlight: a diode has no filament to warm up
});

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

// THREE.SpotLight.angle is the half-angle in radians. Clamped low enough to stay a dot and high
// enough that the cone does not collapse into float dust.
export function dotAngleRad(deg) {
  const d = Math.min(45, Math.max(0.01, Number(deg) || 0));
  return d * Math.PI / 180;
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

export function createWeaponLaser({ THREE, scene, options = null } = {}) {
  if (!THREE?.SpotLight) throw new TypeError('createWeaponLaser needs THREE');
  if (!scene) throw new TypeError('createWeaponLaser needs a scene');
  const cfg = { ...WEAPON_LASER_DEFAULTS, ...(options || {}) };

  // The dot. Resident and intensity-switched, never `.visible`: on the WebGPU backend the set of
  // visible lights keys the render pipeline, so flipping one recompiles every material in the scene
  // (the rule flash-lights.js and weapon-light.js both carry).
  const spot = new THREE.SpotLight(hueToHex(cfg.hue), 0, cfg.range, dotAngleRad(cfg.dotAngleDeg), cfg.penumbra, cfg.decay);
  spot.name = 'weaponLaserDot';
  spot.castShadow = !!cfg.shadows;
  spot.shadow.mapSize.set(cfg.shadowMapSize, cfg.shadowMapSize);
  spot.shadow.camera.near = 0.2;
  spot.shadow.camera.far = Math.max(1, cfg.range);
  spot.shadow.bias = -0.0004;
  spot.shadow.normalBias = 0.02;
  scene.add(spot, spot.target);

  // The beam. Open-ended unit cylinder growing from the origin along +Y, so the transform is just
  // "point it down the bore and scale it to the range". depthWrite off, depthTest ON: the geometry
  // it runs into clips it, which is why this needs no raycast to know where to stop.
  const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true).translate(0, 0.5, 0);
  const beam = new THREE.Mesh(beamGeo, new MeshBasicNodeMaterial({
    color: hueToHex(cfg.hue), transparent: true, opacity: cfg.beamOpacity, depthWrite: false,
    blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide, fog: false,
  }));
  beam.name = 'weaponLaserBeam';
  beam.frustumCulled = false;   // it is re-scaled per frame; a cached bounding sphere is a lie
  beam.visible = false;
  scene.add(beam);

  const _dir = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
  let on = false, level = 0, placed = false;

  function applyColor() {
    const hex = hueToHex(cfg.hue);
    spot.color.setHex(hex);
    beam.material.color.setHex(hex);
  }

  // Anything in WEAPON_LASER_DEFAULTS. `shadows` is the one that costs a pipeline rebuild.
  function configure(patch) {
    if (!patch) return cfg;
    Object.assign(cfg, patch);
    spot.angle = dotAngleRad(cfg.dotAngleDeg);
    spot.penumbra = cfg.penumbra;
    spot.decay = cfg.decay;
    spot.distance = cfg.range;
    spot.shadow.camera.far = Math.max(1, cfg.range);
    if (spot.castShadow !== !!cfg.shadows) spot.castShadow = !!cfg.shadows;
    applyColor();
    return cfg;
  }

  function setOn(next) { on = !!next; return on; }
  function toggle() { return setOn(!on); }

  // source: { muzzle, direction } in scene space, or null when there is nothing to mount to
  // (a knife, a death, a menu).
  function update(dt, source) {
    const usable = !!(source?.muzzle && source?.direction);
    level = rampToward(level, on && usable ? 1 : 0, dt, cfg.rampRate);
    spot.intensity = cfg.intensity * level;
    beam.material.opacity = cfg.beamOpacity * level;
    if (level <= 0.002) {
      if (beam.visible) beam.visible = false;
      return level;
    }
    // Holstering mid-stride leaves nowhere to aim, but cutting the beam that frame is a blink. Hold
    // the last placement and fade out from there, the way the flashlight fades in place.
    if (!usable) return level;

    _dir.set(source.direction[0], source.direction[1], source.direction[2]);
    if (_dir.lengthSq() < 1e-12) return level;
    _dir.normalize();
    spot.position.set(source.muzzle[0], source.muzzle[1], source.muzzle[2]);
    spot.target.position.copy(spot.position).addScaledVector(_dir, Math.max(1, cfg.range));
    spot.target.updateMatrixWorld();
    placed = true;

    // A zero radius is hidden, not drawn at zero scale: a degenerate mesh is still a draw call and
    // still a singular matrix. This is the only place "0 mm" is decided, and it means nothing drawn.
    const radius = Math.max(0, Number(cfg.beamRadius) || 0);
    if (!cfg.beamVisible || radius <= 0) {
      if (beam.visible) beam.visible = false;
      return level;
    }
    beam.position.copy(spot.position);
    beam.quaternion.setFromUnitVectors(_up, _dir);
    beam.scale.set(radius, cfg.range, radius);
    if (!beam.visible) beam.visible = true;
    return level;
  }

  function dispose() {
    scene.remove(spot, spot.target, beam);
    spot.dispose?.();
    beamGeo.dispose();
    beam.material.dispose();
  }

  return {
    spot, beam, configure, setOn, toggle, update, dispose,
    get on() { return on; },
    get level() { return level; },
    get placed() { return placed; },
    get config() { return cfg; },
  };
}
