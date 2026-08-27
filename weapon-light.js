// weapon-light.js — a weapon-mounted flashlight that is an actual light, not a drawn cone.
//
// bot-viewer-v3 fakes this: one instanced additive cone per bot (bot-viewer-visuals.js's `beams`),
// because a real light per bot in a 90-bot firefight is a non-starter. There is one local player
// here, so the beam can be what it should be — a THREE.SpotLight that lands on terrain, walls and
// bodies, plus an optional small point light at the lens for the near spill a bare cone never has.
// Nothing is drawn: no cone mesh, no sprite. What you see is surfaces being lit.
//
// The WebGPU rule from flash-lights.js applies here too: `.visible` feeds the lights hash that keys
// the render pipeline, so flipping it recompiles every material in the scene. The lamp is resident
// and switches on and off through its intensity. `castShadow` is structural in the same way, so it
// is set once at construction and only ever changed by a deliberate settings change.
//
// The geometry helpers are pure and unit-tested in test-weapon-light.mjs.

export const WEAPON_LIGHT_DEFAULTS = Object.freeze({
  intensity: 400,        // candela: /d^2, so ~sunlit at 10 m and still readable at 30
  range: 70,             // metres; 0 would be infinite, which never dims
  angleDeg: 22,          // outer half-angle of the cone
  penumbra: 0.55,        // soft edge; a hard-edged disc reads as a projected texture
  decay: 2,              // physical inverse-square
  warmth: 0.45,          // 0 cool white LED, 1 warm incandescent
  spillIntensity: 3,     // the lamp itself lighting what is beside it
  spillRange: 6,
  rampRate: 26,          // 1/s toward the target: a click with the pop taken off, not a fade
  lensForward: 0.08,     // metres past the muzzle, so the barrel does not shadow its own beam
  targetDistance: 20,
  shadows: false,
  shadowMapSize: 1024,
});

export const WEAPON_LIGHT_COOL = Object.freeze([0.82, 0.89, 1.0]);
export const WEAPON_LIGHT_WARM = Object.freeze([1.0, 0.84, 0.62]);

// Exponential approach, frame-rate independent. rate <= 0 snaps.
export function rampToward(current, target, dt, rate) {
  const c = Number.isFinite(current) ? current : 0;
  const t = Number.isFinite(target) ? target : 0;
  const step = Math.max(0, Number(dt) || 0) * Math.max(0, Number(rate) || 0);
  if (step <= 0) return rate > 0 ? c : t;
  const blend = 1 - Math.exp(-step);
  const next = c + (t - c) * blend;
  return Math.abs(t - next) < 1e-4 ? t : next;
}

// 0..1 between the two authored whites, as a packed hex the THREE.Color constructor takes.
export function flashlightColor(warmth) {
  const w = Math.min(1, Math.max(0, Number(warmth) || 0));
  let hex = 0;
  for (let i = 0; i < 3; i++) {
    const v = WEAPON_LIGHT_COOL[i] + (WEAPON_LIGHT_WARM[i] - WEAPON_LIGHT_COOL[i]) * w;
    hex = (hex << 8) | Math.round(Math.min(1, Math.max(0, v)) * 255);
  }
  return hex;
}

// THREE.SpotLight.angle is the half-angle in radians and misbehaves at the extremes.
export function coneAngleRad(deg) {
  const d = Math.min(80, Math.max(1, Number(deg) || 0));
  return d * Math.PI / 180;
}

// Lamp position and the point it looks at, from a muzzle and a bore direction. Both in and out are
// plain [x, y, z] in the same space the scene lights live in (render-local, like muzzleWorld's).
export function placeFlashlight(muzzle, direction, options, outPosition, outTarget) {
  if (!muzzle || !direction) return null;
  const opts = { ...WEAPON_LIGHT_DEFAULTS, ...(options || {}) };
  const len = Math.hypot(direction[0], direction[1], direction[2]);
  if (!(len > 1e-6)) return null;
  const dx = direction[0] / len, dy = direction[1] / len, dz = direction[2] / len;
  outPosition[0] = muzzle[0] + dx * opts.lensForward;
  outPosition[1] = muzzle[1] + dy * opts.lensForward;
  outPosition[2] = muzzle[2] + dz * opts.lensForward;
  outTarget[0] = outPosition[0] + dx * opts.targetDistance;
  outTarget[1] = outPosition[1] + dy * opts.targetDistance;
  outTarget[2] = outPosition[2] + dz * opts.targetDistance;
  return outPosition;
}

export function createWeaponLight({ THREE, scene, options = null } = {}) {
  if (!THREE?.SpotLight) throw new TypeError('createWeaponLight needs THREE');
  if (!scene) throw new TypeError('createWeaponLight needs a scene');
  const cfg = { ...WEAPON_LIGHT_DEFAULTS, ...(options || {}) };

  const spot = new THREE.SpotLight(flashlightColor(cfg.warmth), 0, cfg.range, coneAngleRad(cfg.angleDeg), cfg.penumbra, cfg.decay);
  spot.name = 'weaponFlashlight';
  spot.castShadow = !!cfg.shadows;
  spot.shadow.mapSize.set(cfg.shadowMapSize, cfg.shadowMapSize);
  spot.shadow.camera.near = 0.2;
  spot.shadow.camera.far = Math.max(1, cfg.range);
  spot.shadow.bias = -0.0006;
  spot.shadow.normalBias = 0.03;
  scene.add(spot, spot.target);

  // The near spill. A spot alone lights only what is inside the cone, so the gun, your own hands and
  // the ground at your feet stay pitch black while the wall ahead is bright — which is the giveaway
  // that the beam is a decal rather than a lamp you are carrying.
  const spill = new THREE.PointLight(flashlightColor(cfg.warmth), 0, cfg.spillRange, cfg.decay);
  spill.name = 'weaponFlashlightSpill';
  scene.add(spill);

  const position = [0, 0, 0], target = [0, 0, 1];
  let on = false, level = 0, hasPlacement = false;

  function applyColor() {
    const hex = flashlightColor(cfg.warmth);
    spot.color.setHex(hex);
    spill.color.setHex(hex);
  }

  // Anything in WEAPON_LIGHT_DEFAULTS. `shadows` is the one that costs a pipeline rebuild.
  function configure(patch) {
    if (!patch) return cfg;
    Object.assign(cfg, patch);
    spot.distance = cfg.range;
    spot.angle = coneAngleRad(cfg.angleDeg);
    spot.penumbra = cfg.penumbra;
    spot.decay = cfg.decay;
    spill.distance = cfg.spillRange;
    spill.decay = cfg.decay;
    spot.shadow.camera.far = Math.max(1, cfg.range);
    if (spot.castShadow !== !!cfg.shadows) spot.castShadow = !!cfg.shadows;
    applyColor();
    return cfg;
  }

  function setOn(next) { on = !!next; return on; }
  function toggle() { return setOn(!on); }

  // source: { muzzle: [x,y,z], direction: [x,y,z] } in scene space, or null when there is nothing to
  // mount to (dead, in a menu, no weapon). Null does not snap the lamp off — it ramps down like the
  // switch, so holstering a gun mid-stride is not a single black frame.
  function update(dt, source) {
    if (source?.muzzle && source?.direction && placeFlashlight(source.muzzle, source.direction, cfg, position, target)) {
      hasPlacement = true;
      spot.position.set(position[0], position[1], position[2]);
      spot.target.position.set(target[0], target[1], target[2]);
      spot.target.updateMatrixWorld();
      spill.position.copy(spot.position);
    }
    const want = on && hasPlacement && source ? 1 : 0;
    level = rampToward(level, want, dt, cfg.rampRate);
    spot.intensity = cfg.intensity * level;
    spill.intensity = cfg.spillIntensity * level;
    return level;
  }

  function dispose() {
    scene.remove(spot, spot.target, spill);
    spot.dispose?.();
    spill.dispose?.();
  }

  return {
    light: spot, spill, configure, setOn, toggle, update, dispose,
    get on() { return on; },
    get level() { return level; },
    get config() { return cfg; },
  };
}
