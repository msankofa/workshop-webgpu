// rain.js — GPU rain for the WebGPU/TSL stack: streaks, splashes, a rain-shadow map and wet ground.
//
// Shape of the idea (after achrefelouafi/RainSystemThreeJS, rewritten for TSL): every drop is one
// instance of a camera-facing quad. Its position is a per-instance hash wrapped with mod() into a
// box that follows the camera, so the field is endless and costs no CPU per frame — the only
// per-frame work is advancing two accumulators (fall distance, wind drift), which is what lets the
// sliders change speed and wind without every drop jumping.
//
// What the reference did not have and this does: an OCCLUDER MAP. `bakeOccluderMap` renders the
// static scene from straight above into a height texture; the streak shader cuts a drop the moment
// it falls below the roof under it, and splashes are placed ON that height, so rain lands on roofs
// and stops under them. Anything in the occluder layer casts rain shadow — buildings, terrain,
// vehicles — with no per-object work.
//
// rain-math.js is the CPU twin of the maths in here (Node-tested); keep it in step by hand.

import * as THREE from 'three/webgpu';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  uniform, varying, texture, vec2, vec3, vec4, float, uint, instanceIndex, positionLocal, uv,
  cameraPosition, positionWorld, normalize, cross, length, mod, floor, fract, sin, cos, exp, mix, color,
  smoothstep, step, clamp, hash, time, cameraViewMatrix, max, mx_fractal_noise_float, normalWorld,
  mx_noise_float, materialRoughness, materialColor, abs,
} from 'three/tsl';

export const RAIN_DEFAULTS = Object.freeze({
  density: 0.35,      // fraction of maxDrops drawn
  speed: 18,          // m/s fall speed (drops vary 0.75..1.25×)
  length: 1.1,        // m streak length
  width: 0.014,       // m streak width
  opacity: 0.55,
  windX: 2.0, windZ: 0.5,
  volume: [44, 36, 44],   // m box around the camera
  splashRadius: 18,       // m disc around the camera that gets splash rings
  splashSize: 0.22,       // m ring diameter at full age
  wetness: 0.8,           // ground darkening + gloss
  ripple: 1.0,            // ripple normal strength on wet ground
  puddle: 0.45,           // puddle coverage 0 (dry) .. 1 (flooded); noise-shaped, not cells
  gust: 3.0,              // m/s peak of the CPU gust wander added on top of uWind
  gustPeriod: 17,         // s per gust cycle; 17 is the rate this file used before it was a setting
  splashRate: 1.6,        // ring generations per second
  splashSlopeMax: 90,     // degrees of ground slope above which rings stop drawing (90 = never)
  splashSlopeFade: 0,     // degrees the suppression fades over, below splashSlopeMax
  splashOrient: 0,        // 0 horizontal rings (as before), 1 laid on the surface normal
  nearStart: 0.25,        // m: streaks fade in over this .. nearEnd so none smear across the lens
  nearEnd: 1.4,
  camLean: 1.0,           // how much camera motion leans the streaks (0 = not at all)
});

// Slope fade as a pair of cosines: rings are full where normal.y > hi and gone below lo. A zero
// fade collapses to "never suppressed", which is what every consumer that does not set it wants.
export function slopeCos(maxDeg, fadeDeg) {
  const R = Math.PI / 180;
  const hi = Math.cos(Math.max(0, Math.min(90, maxDeg - Math.max(0, fadeDeg))) * R);
  const lo = fadeDeg > 0 ? Math.cos(Math.max(0, Math.min(90, maxDeg)) * R) : hi - 0.001;
  return [Math.min(lo, hi - 0.001), hi];
}

// One shared set of uniforms so drops, splashes, wet ground and lightning stay in lockstep.
export function createRainUniforms(overrides = {}) {
  const d = { ...RAIN_DEFAULTS, ...overrides };
  const fallback = new THREE.DataTexture(new Float32Array([0, 0, 0, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  fallback.minFilter = fallback.magFilter = THREE.NearestFilter;
  fallback.needsUpdate = true;
  return {
    uFall: uniform(0),                          // accumulated fall distance (m), CPU-advanced
    uWindOff: uniform(new THREE.Vector3()),     // accumulated wind drift (m), CPU-advanced
    uWind: uniform(new THREE.Vector3(d.windX, 0, d.windZ)),
    uGust: uniform(new THREE.Vector3()),        // slow wander added to uWind, CPU-driven
    uCamVel: uniform(new THREE.Vector3()),      // camera velocity; streaks lean against it
    uSpeed: uniform(d.speed),
    uLength: uniform(d.length),
    uWidth: uniform(d.width),
    uOpacity: uniform(d.opacity),
    uColor: uniform(new THREE.Color(0xb8bcc4)),
    uVolume: uniform(new THREE.Vector3(...d.volume)),
    uLightning: uniform(0),
    uSplashRadius: uniform(d.splashRadius),
    uSplashSize: uniform(d.splashSize),
    uSplashRate: uniform(d.splashRate),
    // Ring suppression by slope, as cosines so the shader compares against the normal's y directly.
    uSlopeCosLo: uniform(slopeCos(d.splashSlopeMax, d.splashSlopeFade)[0]),
    uSlopeCosHi: uniform(slopeCos(d.splashSlopeMax, d.splashSlopeFade)[1]),
    uSplashOrient: uniform(d.splashOrient),
    uNearStart: uniform(d.nearStart),
    uNearEnd: uniform(d.nearEnd),
    uCamLean: uniform(d.camLean),
    uWetness: uniform(d.wetness),
    uRipple: uniform(d.ripple),
    uPuddle: uniform(d.puddle),
    uOccCenter: uniform(new THREE.Vector2()),
    uOccExtent: uniform(1),
    uOccOn: uniform(0),
    occTex: texture(fallback),
    _fallback: fallback,
  };
}

function instancedQuad(count) {
  const plane = new THREE.PlaneGeometry(1, 1);
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', plane.getAttribute('position'));
  g.setAttribute('uv', plane.getAttribute('uv'));
  g.setIndex(plane.getIndex());
  g.instanceCount = count;
  return g;
}

// Height of the tallest occluder under world XZ (0 where nothing was baked).
function roofAt(U, xz) {
  const st = xz.sub(U.uOccCenter).div(U.uOccExtent).add(0.5);
  const inside = step(0, st.x).mul(step(st.x, 1)).mul(step(0, st.y)).mul(step(st.y, 1));
  return U.occTex.sample(st).r.mul(inside).mul(U.uOccOn);
}

// ---- streaks -----------------------------------------------------------------------------------
// `groundHeight(xzNode) -> heightNode` (optional) cuts drops below an analytic surface as well as
// below the occluder map; `colorFn(rgbNode) -> rgbNode` (optional) lets a page retint the drops.
export function createRainStreaks(U, { maxDrops = 30000, groundHeight = null, colorFn = null } = {}) {
  const geom = instancedQuad(maxDrops);
  const mat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });

  const idx = instanceIndex;
  const seed = vec3(hash(idx), hash(idx.add(uint(7919))), hash(idx.add(uint(104729))));
  const rnd = hash(idx.add(uint(1299709)));

  const vol = U.uVolume;
  const origin = cameraPosition.sub(vec3(vol.x.mul(0.5), vol.y.mul(0.85), vol.z.mul(0.5)));
  const speedK = float(0.75).add(rnd.mul(0.5));
  const base = seed.mul(vol);
  const disp = vec3(U.uWindOff.x, U.uFall.mul(speedK).negate(), U.uWindOff.z);
  const pos = mod(base.add(disp).sub(origin), vol).add(origin);

  const windEff = U.uWind.add(U.uGust);
  // Motion relative to the eye: a panning camera sees rain lean the other way, exactly like a car window.
  const velRel = vec3(windEff.x, U.uSpeed.mul(speedK).negate(), windEff.z).sub(U.uCamVel.mul(U.uCamLean));
  const relSpeed = length(velRel);
  const vel = velRel.div(relSpeed.max(0.001));
  const toCam = normalize(cameraPosition.sub(pos));
  const side = normalize(cross(vel, toCam));
  // Streak length is motion blur, so it scales with apparent speed (uLength is the length at 18 m/s).
  const len = U.uLength.mul(float(0.7).add(rnd.mul(0.6))).mul(relSpeed.div(18).clamp(0.25, 3));
  const world = pos.add(side.mul(positionLocal.x.mul(U.uWidth))).add(vel.mul(positionLocal.y.mul(len)));
  mat.positionNode = world;

  const vY = varying(world.y);
  const vRnd = varying(rnd);
  const vNear = varying(smoothstep(U.uNearStart, U.uNearEnd, length(pos.sub(cameraPosition))));  // no smears across the lens
  let cut = roofAt(U, pos.xz);
  if (groundHeight) cut = max(cut, groundHeight(pos.xz));
  const vCut = varying(cut);                                                     // sampled once per drop, in the vertex stage
  const across = smoothstep(0, 0.5, uv().x).mul(smoothstep(1, 0.5, uv().x));
  const along = smoothstep(0, 0.3, uv().y).mul(smoothstep(1, 0.55, uv().y));
  const alpha = across.mul(along).mul(U.uOpacity).mul(float(0.6).add(vRnd.mul(0.4))).mul(step(vCut, vY)).mul(vNear);
  let rgb = U.uColor.mul(float(1).add(U.uLightning.mul(2.5)));
  if (colorFn) rgb = colorFn(rgb);
  mat.colorNode = vec4(rgb, alpha);

  const mesh = new THREE.Mesh(geom, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  return {
    mesh, maxDrops,
    setDensity(f) { geom.instanceCount = Math.max(1, Math.floor(Math.min(1, Math.max(0, f)) * maxDrops)); },
  };
}

// ---- splashes: expanding rings that sit on the roof height under them --------------------------
// `groundSlope(xzNode) -> vec2(dh/dx, dh/dz)` (optional) gives the rings a surface to lie on: they
// fade out above uSlopeCosLo (rain runs off a rock face rather than beading on it) and, with
// uSplashOrient up, tilt to the normal instead of staying horizontal. With no hook the slope is
// central-differenced off `groundHeight` at `slopeStep` metres; with neither, the ground is flat.
export function createRainSplashes(U, { maxSplashes = 6000, groundHeight = null, groundSlope = null, slopeStep = 2, colorFn = null } = {}) {
  const geom = instancedQuad(maxSplashes);
  const mat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });

  const idx = instanceIndex;
  const sx = hash(idx.add(uint(31337)));
  const sz = hash(idx.add(uint(65537)));
  const birth = hash(idx.add(uint(999983)));
  const clock = time.mul(U.uSplashRate).add(birth);
  const cycle = fract(clock);                                          // 0..1 age of this ring
  const gen = floor(clock).toUint().mul(uint(maxSplashes));            // which ring this is
  const jx = hash(idx.add(gen).add(uint(3)));                           // re-place a little each generation
  const jz = hash(idx.add(gen).add(uint(17)));
  // A square that follows the camera, wrapped like the drops: rings stay put in the world and only
  // the ones falling off the trailing edge reappear at the leading edge.
  const span = U.uSplashRadius.mul(2);
  const origin = cameraPosition.xz.sub(U.uSplashRadius);
  const base = vec2(sx, sz).mul(span).add(vec2(jx, jz).mul(1.5));
  const xz = mod(base.sub(origin), vec2(span, span)).add(origin);
  const cx = xz.x, cz = xz.y;
  let ground = roofAt(U, vec2(cx, cz));
  if (groundHeight) ground = max(ground, groundHeight(vec2(cx, cz)));
  // Surface normal from the height gradient. The occluder map is not differenced: it is a hard
  // step at a roof edge, and a step has no slope worth reading.
  let grad = null;
  if (groundSlope) grad = groundSlope(vec2(cx, cz));
  else if (groundHeight) {
    const st = float(slopeStep);
    const dx = groundHeight(vec2(cx.add(st), cz)).sub(groundHeight(vec2(cx.sub(st), cz)));
    const dz = groundHeight(vec2(cx, cz.add(st))).sub(groundHeight(vec2(cx, cz.sub(st))));
    grad = vec2(dx, dz).div(st.mul(2));
  }
  const normal = grad ? normalize(vec3(grad.x.negate(), 1, grad.y.negate())) : vec3(0, 1, 0);
  // Flat basis and surface basis are the same vectors when the ground is level, so orient 0 and 1
  // agree there and the slider only does anything on a slope.
  const tang = normalize(cross(normal, vec3(0, 0, 1)));
  const bitan = cross(tang, normal);
  const ax = mix(vec3(1, 0, 0), tang, U.uSplashOrient);
  const az = mix(vec3(0, 0, 1), bitan, U.uSplashOrient);
  const lift = mix(vec3(0, 1, 0), normal, U.uSplashOrient).mul(0.012);
  const size = U.uSplashSize.mul(float(0.3).add(cycle.mul(0.7)));
  const world = vec3(cx, ground, cz).add(lift)
    .add(ax.mul(positionLocal.x.mul(size)))
    .add(az.mul(positionLocal.y.mul(size)));
  mat.positionNode = world;

  const vCycle = varying(cycle);
  const vSlope = varying(smoothstep(U.uSlopeCosLo, U.uSlopeCosHi, normal.y));
  const d = length(uv().sub(0.5)).mul(2);                               // 0 centre .. 1 edge
  const ring = smoothstep(0.55, 0.85, d).mul(smoothstep(1.0, 0.9, d));
  const alpha = ring.mul(float(1).sub(vCycle)).mul(0.6).mul(U.uOpacity.mul(1.4).clamp(0, 1)).mul(vSlope);
  let rgb = U.uColor.mul(float(1.1).add(U.uLightning.mul(2)));
  if (colorFn) rgb = colorFn(rgb);
  mat.colorNode = vec4(rgb, alpha);

  const mesh = new THREE.Mesh(geom, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 9;
  return {
    mesh, maxSplashes,
    setDensity(f) { geom.instanceCount = Math.max(1, Math.floor(Math.min(1, Math.max(0, f)) * maxSplashes)); },
  };
}

// ---- wet-surface fields, shared -------------------------------------------------------------------
// applyWetSurface below and terrain-splat-streamed.js's `rain` bundle both need the same puddles
// and the same ripples. They are exported rather than copied because a hand-synced second copy of
// this maths would drift, and then rain would bead differently on the terrain than on everything
// standing on it. `pw` is the WORLD xz to evaluate at — a page that rebases its render origin
// passes scene xz + offset, so the puddles stay with the ground rather than with the camera.

// Puddles: an FBM field thresholded by coverage, so they are blotches with soft shores, not tiles.
// `up` gates them to level ground; pass float(1) for a surface that is already known to be flat.
export function wetPuddleField(U, pw, up, puddleScale = 0.09) {
  const n = mx_fractal_noise_float(pw.mul(puddleScale), 3, 2.0, 0.55).mul(0.5).add(0.5);
  const thr = float(1).sub(U.uPuddle.mul(U.uWetness).mul(0.9));
  return smoothstep(thr.sub(0.09), thr.add(0.09), n).mul(up);
}

// Ripples: one expanding ring per cell with a hashed birth; strong inside puddles, faint on the
// film outside. Returns the xz the surface normal should be bent by (y is untouched).
export function wetRippleOffset(U, pw, puddle, rippleScale = 3.0) {
  const p = pw.mul(rippleScale);
  const cell = floor(p).add(4096);   // keep cells positive: toUint() of a negative float is undefined
  const f = fract(p).sub(0.5);
  const h = hash(cell.x.toUint().mul(uint(1973)).add(cell.y.toUint().mul(uint(9277))));
  const h2 = hash(cell.x.toUint().mul(uint(4177)).add(cell.y.toUint().mul(uint(21277))).add(uint(3)));
  const life = fract(time.mul(1.3).add(h));
  const rr = life.mul(0.5);
  const dist = length(f);
  const wave = sin(dist.sub(rr).mul(40)).mul(exp(dist.mul(-4))).mul(float(1).sub(life)).mul(step(dist, rr));
  const gate = step(0.3, h2).mul(mix(0.25, 1.0, puddle)).mul(U.uRipple).mul(U.uWetness);
  return vec2(wave.mul(f.x).mul(-6).mul(gate), wave.mul(f.y).mul(-6).mul(gate));
}

// How much wetness darkens albedo and how much it drops roughness, given a puddle mask and an
// optional run-off streak mask. Both consumers apply these the same way, so they agree by
// construction rather than by inspection.
export function wetAlbedoScale(U, puddle, streak = null) {
  const extra = streak ? puddle.mul(0.35).add(streak.mul(0.18)) : puddle.mul(0.35);
  return float(1).sub(U.uWetness.mul(float(0.3).add(extra)));
}
export function wetRoughness(U, rough, puddle, streak = null) {
  const dry = streak ? U.uWetness.mul(float(0.35).add(streak.mul(0.3))) : U.uWetness.mul(0.35);
  return mix(rough.mul(float(1).sub(dry)), float(0.06), puddle.mul(U.uWetness));
}

// ---- wet surfaces: apply to any MeshStandardNodeMaterial -----------------------------------------
// baseColor / baseRoughness are nodes (or numbers); baseRoughness null reads the material's own
// `roughness` live via `materialRoughness`. Returns nothing; mutates the material.
// `baseNormal` is the world-space normal node the ripples perturb (default `normalWorld`); pass the
// material's own graph when it already bends the normal, or the ripples flatten slopes.
// Puddles and ripples only form on up-facing surface (normal.y > ~0.75); side faces get a darker,
// glossier film with rain streaks running down them (`streaks: false` turns those off), so one call
// serves floors, roofs, walls and cover.
export function applyWetSurface(mat, U, { baseColor, baseRoughness = null, baseNormal = null, rippleScale = 3.0, puddleScale = 0.09, streaks = true } = {}) {
  const wet = U.uWetness;
  const pw = positionWorld.xz;
  const nBase = baseNormal || normalWorld;
  const up = smoothstep(0.6, 0.9, nBase.y);
  const puddle = wetPuddleField(U, pw, up, puddleScale);
  // Side faces: columns of run-off sliding down. Phase from x+z so it works on either wall axis.
  let streak = float(0);
  if (streaks) {
    const along = positionWorld.x.add(positionWorld.z);
    const run = mx_noise_float(vec3(along.mul(3.0), positionWorld.y.mul(0.35).sub(time.mul(0.45)), 0)).mul(0.5).add(0.5);
    streak = smoothstep(0.55, 0.85, run).mul(float(1).sub(up)).mul(smoothstep(0.35, 0.05, abs(nBase.y)));
  }
  const ripple = wetRippleOffset(U, pw, puddle, rippleScale);
  const nWorld = normalize(nBase.add(vec3(ripple.x, 0, ripple.y)));
  // A material with a plain `color` and no colorNode has nothing here to wrap, so it goes glossy
  // without going dark. Pass `baseColor: materialColor` to darken the material's own colour, which
  // is what a page wants for anything it did not build a colour graph for. Left opt-in rather than
  // defaulted so the pages already calling this keep the look they have.
  let col = baseColor === undefined ? mat.colorNode : baseColor;
  if (col && !col.isNode) col = color(col);   // THREE.Color or hex
  const rough = baseRoughness == null ? materialRoughness : typeof baseRoughness === 'number' ? float(baseRoughness) : baseRoughness;   // null: the material's own roughness, live
  if (col) mat.colorNode = col.mul(wetAlbedoScale(U, puddle, streak));
  mat.roughnessNode = wetRoughness(U, rough, puddle, streak);
  // world -> view. transformNormalToView would be wrong here: it applies the object->world
  // normal matrix first, so any rotated mesh (walls, cover) would get its normal turned twice.
  mat.normalNode = cameraViewMatrix.transformDirection(nWorld);
}

// ---- wet sheen: the cheap version for props and bodies --------------------------------------------
// Roughness comes down and albedo darkens a little with wetness; no puddles, no normal work. Reads
// the material's own `roughness` through `materialRoughness`, so a theme that retunes it still wins.
export function applyWetSheen(mat, U, { amount = 0.5, darken = 0.15 } = {}) {
  const wet = U.uWetness;
  mat.colorNode = (mat.colorNode || materialColor).mul(float(1).sub(wet.mul(darken)));   // instance colour still multiplies in
  mat.roughnessNode = (mat.roughnessNode || materialRoughness).mul(float(1).sub(wet.mul(amount)));
}

// ---- occluder map ------------------------------------------------------------------------------
// Renders every object on `layer` from straight above into a height texture centred on `center`
// spanning `extent` metres, and points the rain uniforms at it. Call once for a static scene, or
// again after the scene changes. The ground itself must be on the layer so open ground bakes 0.
export function bakeOccluderMap(renderer, scene, U, { center = [0, 0], extent = 120, size = 512, layer = 1, top = 200 } = {}) {
  const rt = new THREE.RenderTarget(size, size, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: true,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
  });
  const half = extent / 2;
  const cam = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, top + 50);
  cam.position.set(center[0], top, center[1]);
  cam.up.set(0, 0, -1);           // +v of the texture = +z of the world
  cam.lookAt(center[0], 0, center[1]);
  cam.updateMatrixWorld();
  cam.layers.set(layer);
  const heightMat = new MeshBasicNodeMaterial({ fog: false });   // fog would bend the heights
  heightMat.colorNode = vec4(max(positionWorld.y, 0), 0, 0, 1);
  const prevRT = renderer.getRenderTarget();
  const prevOverride = scene.overrideMaterial;
  const prevClear = new THREE.Color(); renderer.getClearColor(prevClear);
  const prevAlpha = renderer.getClearAlpha();
  scene.overrideMaterial = heightMat;
  renderer.setClearColor(0x000000, 1);
  renderer.setRenderTarget(rt);
  renderer.render(scene, cam);
  renderer.setRenderTarget(prevRT);
  renderer.setClearColor(prevClear, prevAlpha);
  scene.overrideMaterial = prevOverride;
  U.occTex.value = rt.texture;
  U.uOccCenter.value.set(center[0], center[1]);
  U.uOccExtent.value = extent;
  U.uOccOn.value = 1;
  return { rt, cam, dispose() { rt.dispose(); } };
}

// ---- lightning: a jagged tube bolt with branches --------------------------------------------------
// `strike(top, hit)` rebuilds the bolt between two world points; `update(dt)` flickers it out.
// Radius scales with the bolt's length so a 1.5 km bolt reads from a cockpit and a 60 m one from a yard.
export function createLightningBolt(scene, { material = null, colorFn = null } = {}) {
  const mat = material || new MeshBasicNodeMaterial({ fog: false, transparent: true, depthWrite: false });
  if (!material) {
    let rgb = vec3(2.4, 2.6, 3.2);
    if (colorFn) rgb = colorFn(rgb);
    mat.colorNode = vec4(rgb, float(1));
  }
  const group = new THREE.Group(); group.name = 'lightning'; group.visible = false;
  scene.add(group);
  let life = 0;
  const walk = (from, to, jitter, steps) => {
    const pts = [from.clone()];
    for (let i = 1; i < steps; i++) {
      const t = i / steps, p = from.clone().lerp(to, t);
      p.x += (Math.random() - 0.5) * jitter * (1 - t * 0.5);
      p.z += (Math.random() - 0.5) * jitter * (1 - t * 0.5);
      p.y += (Math.random() - 0.5) * jitter * 0.4;
      pts.push(p);
    }
    pts.push(to.clone());
    return pts;
  };
  const tube = (pts, radius) => {
    const m = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.0), pts.length * 2, radius, 5, false), mat);
    m.frustumCulled = false; return m;
  };
  return {
    group, material: mat,
    strike(top, hit, { duration = 0.14 + Math.random() * 0.1 } = {}) {
      for (const b of group.children) b.geometry.dispose();
      group.clear();
      const L = top.distanceTo(hit), jit = L * 0.1, r = Math.max(0.05, L * 0.0023);
      const main = walk(top, hit, jit, 14);
      group.add(tube(main, r));
      for (let k = 0; k < 2 + Math.floor(Math.random() * 3); k++) {          // branches peel off the upper half
        const i = 2 + Math.floor(Math.random() * (main.length * 0.5));
        const from = main[i];
        const to = from.clone().add(new THREE.Vector3((Math.random() - 0.5) * L * 0.3, -L * (0.13 + Math.random() * 0.23), (Math.random() - 0.5) * L * 0.3));
        group.add(tube(walk(from, to, jit * 0.5, 6), r * 0.36));
      }
      group.visible = true; life = duration;
    },
    update(dt) {
      if (life <= 0) return;
      life -= dt;
      group.visible = life > 0 && Math.random() > 0.2;                        // flicker
    },
    get active() { return life > 0; },
  };
}

// ---- sound: a pink-noise rain bed and a brown-noise thunder clap, plain WebAudio -----------------
export function createRainBed(ctx, destination) {
  const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < len; i++) {           // pink-ish noise reads as rain better than white
    const w = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.0990460; b1 = 0.96300 * b1 + w * 0.2965164; b2 = 0.57000 * b2 + w * 1.0526913;
    d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.11;
  }
  const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200; lp.Q.value = 0.4;
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 350;
  const gain = ctx.createGain(); gain.gain.value = 0;
  src.connect(hp).connect(lp).connect(gain).connect(destination); src.start();
  return {
    gain, lp,
    // level 0..1 opens the gain and the low-pass together, so light rain is quiet AND dull.
    set(level) { gain.gain.value = 0.9 * level; lp.frequency.value = 1800 + 3000 * level; },
    stop(at) { try { src.stop(at); } catch { /* already stopped */ } },
  };
}

export function playThunder(ctx, destination, { volume = 0.9, distance = 0 } = {}) {
  const dur = 2.5 + Math.random() * 2 + distance / 800;                    // far thunder rolls longer
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate), d = buf.getChannelData(0);
  let lp = 0;
  const crack = Math.max(0, 1 - distance / 1500);                          // the crack dies with distance, the roll does not
  for (let i = 0; i < d.length; i++) {                                     // brown noise with a crack at the front
    lp += (Math.random() * 2 - 1) * 0.02; lp *= 0.998;
    const t = i / ctx.sampleRate;
    const env = Math.exp(-t * (1.6 - Math.min(1.0, distance / 3000))) * (t < 0.08 ? t / 0.08 : 1) + Math.exp(-t * 20) * 0.6 * crack;
    d[i] = lp * 8 * env;
  }
  const src = ctx.createBufferSource(); src.buffer = buf;
  const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = (220 + Math.random() * 180) * Math.max(0.35, 1 - distance / 4000);
  const g = ctx.createGain(); g.gain.value = volume * Math.max(0.25, 1 - distance / 6000);
  src.connect(f).connect(g).connect(destination); src.start();
  return dur;
}

// ---- system: everything wired together ---------------------------------------------------------
export function createRainSystem(opts = {}) {
  // `uniformSet` reuses an existing set instead of building one. A page that reallocates the
  // instanced geometry (a max-drops slider) must pass it, or every other holder of the old set —
  // a wet-ground material graph, which captured the node objects at compile time — is left reading
  // uniforms nothing writes to any more.
  const U = opts.uniformSet || createRainUniforms(opts.uniforms || {});
  const streaks = createRainStreaks(U, opts);
  const splashes = createRainSplashes(U, opts);
  const group = new THREE.Group();
  group.name = 'rain';
  group.add(streaks.mesh, splashes.mesh);
  let density = opts.density ?? RAIN_DEFAULTS.density;
  streaks.setDensity(density); splashes.setDensity(density);
  let lightningDecay = 0;
  const gustT = [0, 0], lastCam = new THREE.Vector3(), camVel = new THREE.Vector3(), tmp = new THREE.Vector3();
  let haveCam = false, gustAmp = opts.gust ?? RAIN_DEFAULTS.gust;
  // The two wander rates below were 0.37 and 0.23 rad/s, i.e. a ~17 s cycle. Keep that the default
  // and scale both together, so a storm can gust slowly and a drizzle quickly.
  let gustRate = RAIN_DEFAULTS.gustPeriod / (opts.gustPeriod ?? RAIN_DEFAULTS.gustPeriod);
  return {
    group, uniforms: U, streaks, splashes,
    // Advance the fall/wind accumulators; pass the camera so streaks can lean against its motion.
    update(dt, camera) {
      gustT[0] += dt * 0.37 * gustRate; gustT[1] += dt * 0.23 * gustRate;
      U.uGust.value.set(Math.sin(gustT[0]) * Math.sin(gustT[1] * 1.7) * gustAmp, 0, Math.sin(gustT[1]) * Math.cos(gustT[0] * 0.6) * gustAmp);
      U.uFall.value += U.uSpeed.value * dt;
      tmp.copy(U.uWind.value).add(U.uGust.value);
      U.uWindOff.value.addScaledVector(tmp, dt);
      if (camera) {
        if (haveCam && dt > 0) camVel.copy(camera.position).sub(lastCam).divideScalar(dt);
        lastCam.copy(camera.position); haveCam = true;
        U.uCamVel.value.lerp(camVel, Math.min(1, dt * 8));   // smoothed; raw per-frame deltas jitter
      }
      if (U.uLightning.value > 0) U.uLightning.value = Math.max(0, U.uLightning.value - dt * lightningDecay);
    },
    setGust(a) { gustAmp = a; },
    getGust() { return gustAmp; },
    setGustPeriod(seconds) { gustRate = RAIN_DEFAULTS.gustPeriod / Math.max(0.05, seconds); },
    // Degrees of ground slope where rings stop, and how many degrees below that the fade takes.
    setSplashSlope(maxDeg, fadeDeg) {
      const [lo, hi] = slopeCos(maxDeg, fadeDeg);
      U.uSlopeCosLo.value = lo; U.uSlopeCosHi.value = hi;
    },
    setSplashOrient(v) { U.uSplashOrient.value = Math.max(0, Math.min(1, v)); },
    setDensity(f) { density = f; streaks.setDensity(f); splashes.setDensity(f); },
    getDensity() { return density; },
    setWind(x, z) { U.uWind.value.set(x, 0, z); },
    flash(strength = 1, decay = 4) { U.uLightning.value = strength; lightningDecay = decay; },
    setVisible(v) { group.visible = v; },
  };
}
