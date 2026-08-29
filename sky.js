// sky.js
// Owner module for the WebGPU procedural sky: a camera-following group holding a gradient
// sky dome, the primary sun/moon sprite (locked to the scene light direction), and the
// composed star field + Milky Way + extra celestial bodies. Pure math is in sky-field.js;
// this file builds node materials + canvas textures and manages the lifecycle.
import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { Fn, float, vec3, mix, smoothstep, positionLocal, normalize, pow, max, abs, dot, uniform } from 'three/tsl';
import { makePalette, skyRadius, isMoonBody, sunSpritePlacement, makeRng,
  generateStars, generateMilkyWay, generateCelestialBodies,
  makeSkyStates, DEFAULT_THRESHOLDS, domeParamsAtElevation, nightnessAtElevation } from './sky-field.js?v=sp7-hdplanets';
import { createSkyStars, createMilkyWay } from './stars.js?v=sp7-hdplanets';
import { createCelestialBodies } from './celestial-bodies.js?v=sp7-hdplanets';

const _c = hex => new THREE.Color(hex);
const v3 = c => vec3(c.r, c.g, c.b);

// Orient helper for the sun/moon discs (plane meshes, not sprites, so the moon's baked maria
// don't appear to spin as the view yaws). Each disc owns its own 1x1 plane geometry (built in
// makeDisc) so disposeTree can free it on a rebuild without hitting a shared buffer. The disc
// faces the group origin (camera) at its placed position; re-oriented on reposition, not per frame.
const _zAxis = new THREE.Vector3(0, 0, 1);
const _worldUp = new THREE.Vector3(0, 1, 0);
const _fn = new THREE.Vector3(), _fr = new THREE.Vector3(), _fu = new THREE.Vector3(), _fbasis = new THREE.Matrix4();
function faceOrigin(obj) {
  _fn.copy(obj.position).multiplyScalar(-1).normalize();
  const up = Math.abs(_fn.y) > 0.99 ? _zAxis : _worldUp;
  _fr.crossVectors(up, _fn).normalize();
  _fu.crossVectors(_fn, _fr).normalize();
  _fbasis.makeBasis(_fr, _fu, _fn);
  obj.quaternion.setFromRotationMatrix(_fbasis);
}

// Gradient dome: bottom->horizon->top by view-direction Y, plus a directional horizon glow.
// All colors + transition params + sun direction are UNIFORMS so the per-frame time-of-day
// blend and every slider write .value with no material rebuild (rebuild races the WebGPU submit).
// The dome colour along a unit direction (shared with anything that reflects the sky, e.g. water).
function skyColorAlong(u, p) {
  const y = p.y.sub(u.horizonHeight);                          // horizon band shifts with time of day
  const up = smoothstep(0.0, u.zenithSoftness, y);            // horizon -> zenith
  const down = smoothstep(0.0, -0.5, y);                      // horizon -> nadir
  const aboveCol = mix(u.horizon, u.top, up);
  const belowCol = mix(u.horizon, u.bottom, down);
  const base = mix(aboveCol, belowCol, smoothstep(0.05, -0.05, y));  // soft horizon crossover
  const band = pow(max(float(1).sub(abs(y).div(u.glowWidth)), float(0)), float(2.0)); // horizon glow falloff
  // Bias the glow toward the sun azimuth: dot of horizontal dome dir vs sun dir, mapped [0,1].
  const align = dot(normalize(p.xz), normalize(u.sunDir.xz)).mul(0.5).add(0.5);
  const glowAmt = band.mul(mix(float(1.0), align, u.glowDirectionality)).mul(u.glowStrength);
  const sky = mix(base, u.glow, glowAmt);
  // Overcast lid: a flat grey that is brighter at the horizon than overhead, which is how a real
  // overcast sky reads. At full overcast this also matches the cloud decks, so their far rim stops
  // being a boundary between white cloud and blue sky (scene fog cannot do that job — an exp2 fog
  // dense enough to be seen at all is total by 10 km, so it would erase the decks, not soften them).
  const lid = u.overcastColor.mul(mix(float(1.15), float(0.75), up));
  return mix(sky, lid, u.overcast);
}
function makeSkyDomeMaterial(u) {
  const mat = new MeshBasicNodeMaterial({ side: THREE.BackSide, depthTest: false, depthWrite: false });
  mat.fog = false;
  mat.colorNode = Fn(() => skyColorAlong(u, normalize(positionLocal)))();
  return mat;
}

// Build the persistent dome uniform bundle from an initial dome parameter set.
function makeDomeUniforms(state) {
  return {
    top: uniform(new THREE.Color(state.top)),
    horizon: uniform(new THREE.Color(state.horizon)),
    bottom: uniform(new THREE.Color(state.bottom)),
    glow: uniform(new THREE.Color(state.glow)),
    horizonHeight: uniform(state.horizonHeight),
    zenithSoftness: uniform(state.zenithSoftness),
    glowWidth: uniform(state.glowWidth),
    glowStrength: uniform(state.glowStrength),
    sunDir: uniform(new THREE.Vector3(0, 1, 0)),
    glowDirectionality: uniform(0.35),
    overcast: uniform(0.0),                                   // 0 clear .. 1 fully lidded
    overcastColor: uniform(new THREE.Color(0.42, 0.44, 0.48)),
  };
}

// 256² sun (warm disc + corona) or 512² moon (glow + shaded sphere + maria).
// Drawing is split out so a live colour change can repaint the SAME canvas in place
// (texture.needsUpdate re-uploads; no dispose, so it cannot race the WebGPU submit).
function makeSkySunTexture(color, { moon }) {
  const cv = document.createElement('canvas'); cv.width = cv.height = moon ? 512 : 256;
  paintSkyDiscCanvas(cv, color, moon);
  const tex = new THREE.CanvasTexture(cv);
  tex.userData.proceduralSkyTexture = true; tex.colorSpace = THREE.SRGBColorSpace; tex.needsUpdate = true;
  return tex;
}
function paintSkyDiscCanvas(cv, color, moon) {
  const S = cv.width;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, S, S);
  const cx = S / 2, cy = S / 2;
  if (moon) {
    const R = S * 0.3;
    // Outer glow radius must stay inside the canvas, else the radial gradient is clipped
    // to the square and shows a hard rectangular halo. Cap at ~half the texture.
    const glow = g.createRadialGradient(cx, cy, R, cx, cy, Math.min(R * 1.7, S * 0.49));
    glow.addColorStop(0, hexA(color, 0.4)); glow.addColorStop(1, hexA(color, 0));
    g.fillStyle = glow; g.fillRect(0, 0, S, S);
    const sh = g.createRadialGradient(cx - R * 0.35, cy - R * 0.35, R * 0.1, cx, cy, R);
    sh.addColorStop(0, lighten(color, 0.4)); sh.addColorStop(0.75, color); sh.addColorStop(1, darken(color, 0.5));
    g.fillStyle = sh; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
    g.save(); g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.clip();
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * Math.PI * 2, rr = Math.random() * R * 0.7;
      g.fillStyle = hexA(darken(color, 0.25), 0.5);
      g.beginPath(); g.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, R * (0.08 + Math.random() * 0.16), 0, Math.PI * 2); g.fill();
    }
    g.restore();
    const ld = g.createRadialGradient(cx, cy, R * 0.6, cx, cy, R);
    ld.addColorStop(0, 'rgba(0,0,0,0)'); ld.addColorStop(1, 'rgba(0,0,0,0.4)');
    g.fillStyle = ld; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
  } else {
    const R = S * 0.22;
    const cor = g.createRadialGradient(cx, cy, R * 0.5, cx, cy, Math.min(R * 2.2, S * 0.49));
    cor.addColorStop(0, hexA(color, 0.9)); cor.addColorStop(0.4, hexA(color, 0.25)); cor.addColorStop(1, hexA(color, 0));
    g.fillStyle = cor; g.fillRect(0, 0, S, S);
    const disc = g.createRadialGradient(cx - R * 0.2, cy - R * 0.2, R * 0.1, cx, cy, R);
    disc.addColorStop(0, '#ffffff'); disc.addColorStop(0.5, color); disc.addColorStop(1, hexA(color, 0.85));
    g.fillStyle = disc; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
  }
}

export function createSky({ scene, camera, size, palette: overrides, sunDir, parts = {} }) {
  let palette = makePalette(overrides);
  const group = new THREE.Group();
  group.userData.followCamera = true;
  let radius = skyRadius(camera.far, size);
  let dir = (sunDir || new THREE.Vector3(0.6, 0.55, 0.58)).clone().normalize();
  let moonDir = null; // unset until setMoonDir() is called; setSunDir() drives the moon sprite until then

  let dome, sunSprite, moonSprite, starsPoints, starsMax, milkyWayGroup, milkyGas, bodiesGroup;
  // Live component visibility belongs to the sky module, not to callers reaching into child
  // indices. Keep the masks across rebuilds so a loaded state cannot be undone by a later seed or
  // palette change. Sun/moon start in the legacy primary-body mode until a caller explicitly
  // supplies independent visibility.
  const componentVisible = { dome: true, stars: true, milkyWay: true, bodies: true };
  let celestialVisible = null;

  // Time-of-day: keyframed states + elevation thresholds live here (the UI mutates these
  // objects in place via the getters below; updateDome reads them every frame).
  let skyStates = makeSkyStates(overrides && overrides.skyStates);
  let thresholds = Object.assign({}, DEFAULT_THRESHOLDS, overrides && overrides.thresholds);
  const domeU = makeDomeUniforms(domeParamsAtElevation(elevFromDir(), thresholds, skyStates));
  domeU.sunDir.value.copy(dir);
  let _nightness = nightnessAtElevation(elevFromDir(), thresholds);
  let celestialFollowTime = false;
  let stableCelestialLayering = true;   // on by default: keeps companion moons from swapping in
                                        // front of / behind their planet as camera pitch changes

  function elevFromDir() { return Math.asin(Math.max(-1, Math.min(1, dir.y))) * 180 / Math.PI; }

  // Write the blended dome params for a sun elevation into the uniforms + scene.background,
  // cache nightness, and (when enabled) fade celestials by nightness. Pure uniform/opacity
  // writes — no rebuild, no dispose.
  function applyDome(elevDeg) {
    const pr = domeParamsAtElevation(elevDeg, thresholds, skyStates);
    domeU.top.value.set(pr.top); domeU.horizon.value.set(pr.horizon);
    domeU.bottom.value.set(pr.bottom); domeU.glow.value.set(pr.glow);
    domeU.horizonHeight.value = pr.horizonHeight; domeU.zenithSoftness.value = pr.zenithSoftness;
    domeU.glowWidth.value = pr.glowWidth; domeU.glowStrength.value = pr.glowStrength;
    _nightness = nightnessAtElevation(elevDeg, thresholds);
    if (scene && scene.background && scene.background.isColor) {
      scene.background.set(pr.bottom);
      // Anything reading scene.background as "the sky colour" (fog tint) should see the lid too.
      if (domeU.overcast.value > 0) scene.background.lerp(domeU.overcastColor.value, domeU.overcast.value);
    }
    const f = celestialFollowTime ? _nightness : 1;
    if (starsPoints && starsPoints.material._uOpacity) starsPoints.material._uOpacity.value = (palette.starOpacity ?? 1) * f;
    if (milkyGas && milkyGas.material._uIntensity) milkyGas.material._uIntensity.value = (palette.milkyWayIntensity ?? 0.7) * f;
    if (bodiesGroup) bodiesGroup.traverse(o => { if (o.material) o.material.opacity = f; });
  }

  function build() {
    // A rebuild detaches the previous tree before entering here. Clear object references first so
    // a palette that omits one optional layer cannot leave a setter targeting the detached layer.
    starsPoints = null; starsMax = 0; milkyWayGroup = null; milkyGas = null; bodiesGroup = null;
    // dome
    dome = new THREE.Mesh(new THREE.SphereGeometry(radius, 40, 18), makeSkyDomeMaterial(domeU));
    dome.name = 'skyDome';   // named so a heat sweep (vision-modes.js) can find it and call it cold
    dome.renderOrder = -1000; dome.frustumCulled = false;
    dome.visible = componentVisible.dome;
    group.add(dome);
    // Build BOTH the sun disc and the moon disc up front. Switching between them is a
    // visibility toggle (see setCelestialType) — NOT a rebuild — so the Sun/Moon control
    // never disposes/recreates GPU resources mid-render (the cause of the night freeze).
    sunSprite  = makeDisc(palette.sun,       false);
    moonSprite = makeDisc(palette.moonColor, true);
    group.add(sunSprite, moonSprite);
    updateDiscVisibility();
    placeSun();
    // stars (parts.* let the viewer bisect which object triggers a GPU error).
    // Build the buffer ONCE at max capacity; the "Star count" control changes the draw
    // range (setStarCount) rather than rebuilding — runtime rebuild/dispose races the
    // async WebGPU submit and crashes. Generated count is clamped to STAR_MAX so the
    // slider (≤3000) never needs more vertices than exist.
    // One base seed drives all three generators so a single control re-rolls the whole sky.
    // XOR salts keep the star field / Milky Way / bodies decorrelated (a shared raw seed
    // would sync their RNG streams). setSeed() changes palette.seed and rebuilds.
    const seed = (palette.seed >>> 0) || 1;
    if (parts.stars !== false) {
      starsMax = Math.max(3000, palette.starCount | 0);
      const rng = makeRng((seed ^ 0x5a17) >>> 0);
      starsPoints = createSkyStars(generateStars(radius, makePalette({ ...palette, starCount: starsMax }), rng), palette);
      starsPoints.geometry.setDrawRange(0, Math.min(palette.starCount | 0, starsMax));
      starsPoints.visible = componentVisible.stars;
      group.add(starsPoints);
    }
    // milky way (intensity is a live uniform — see setMilkyWayIntensity)
    if (parts.milkyWay !== false) {
      milkyWayGroup = createMilkyWay(generateMilkyWay(radius, palette, makeRng((seed ^ 0xb1a5) >>> 0)), palette);
      if (milkyWayGroup) {
        milkyWayGroup.visible = componentVisible.milkyWay;
        group.add(milkyWayGroup);
        milkyGas = milkyWayGroup.userData.gas || null;
      }
    }
    // celestial bodies (night/dusk only — gate on milkyWay flag as the night marker).
    // palette.bodies === true keeps bodies when a palette turns the Milky Way off alone.
    bodiesGroup = null;
    if (parts.bodies !== false && (palette.milkyWay || palette.bodies === true)) {
      bodiesGroup = createCelestialBodies(generateCelestialBodies(radius, palette, makeRng((seed ^ 0xc0de) >>> 0)),
        { resScale: palette.bodyResolution ?? 1, faceMode: 'fixed' });
      bodiesGroup.userData.setStableLayering?.(stableCelestialLayering);
      bodiesGroup.visible = componentVisible.bodies;
      group.add(bodiesGroup);
    }
    if (scene && (!scene.background || !scene.background.isColor)) scene.background = new THREE.Color();
    applyDome(elevFromDir());
  }

  function makeDisc(color, moon) {
    const tex = makeSkySunTexture(color, { moon });
    const m = new MeshBasicNodeMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    m.fog = false;
    m.opacity = (moon ? palette.moonOpacity : palette.sunOpacity) ?? 1;
    const spr = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), m);
    spr.renderOrder = -995;   // frontmost sky layer: in front of stars (-997) and bodies (-996)
    spr.frustumCulled = false; // large scale + far position can false-cull the disc at the view edge
    spr.userData.moon = moon;
    return spr;
  }

  function updateDiscVisibility() {
    if (celestialVisible) {
      if (sunSprite) sunSprite.visible = celestialVisible.sun;
      if (moonSprite) moonSprite.visible = celestialVisible.moon;
      return;
    }
    const moon = isMoonBody(palette);
    if (sunSprite)  sunSprite.visible  = !moon;
    if (moonSprite) moonSprite.visible = moon;
  }

  function placeDisc(spr, d) {
    // The moon disc may size independently (palette.moonSize); it falls back to the shared sunSize.
    const size = spr.userData.moon ? (palette.moonSize ?? palette.sunSize) : palette.sunSize;
    const p = sunSpritePlacement([d.x, d.y, d.z], radius, { ...palette, sunSize: size, celestialType: spr.userData.moon ? 'moon' : 'sun' });
    spr.position.set(p.position.x, p.position.y, p.position.z);
    spr.scale.set(p.scale, p.scale, 1);
    faceOrigin(spr);   // discs are meshes now; orient toward the camera at the new position
  }
  function placeSun() { if (sunSprite) placeDisc(sunSprite, dir); if (moonSprite) placeDisc(moonSprite, moonDir || dir); }
  function placeMoon() { if (moonSprite) placeDisc(moonSprite, moonDir); }

  build();
  const builtRadius = radius;   // geometry is fixed at this radius; setRadius() only scales

  function detachAll() {
    // Reparent the live children into a throwaway group (does NOT touch the GPU).
    const old = new THREE.Group();
    for (let i = group.children.length - 1; i >= 0; i--) old.add(group.children[i]);
    return old;
  }

  // Disposal is queued and AGE-GATED, never run inline or from a bare rAF. With the sync
  // render() path, render() returns before the GPU finishes, so the just-detached objects
  // can still be referenced by a frame in flight; disposing immediately → "Buffer used in
  // submit while destroyed". flushDisposals() (called once per frame by the viewer) only
  // frees a tree after it has survived a couple of frames, by which point no submit refers
  // to it. Runtime controls below avoid rebuild entirely, so this only fires on the rare
  // view-distance rebuild.
  const _pending = [];
  function disposeTree(root) {
    root.traverse(o => {
      // Defensive: THREE.Sprite instances share ONE module-level QuadGeometry, so disposing a
      // sprite's geometry destroys the buffer other live sprites still draw from ("buffer used in
      // submit while destroyed"). This sky builds no sprites — the discs and celestial bodies are
      // plane meshes, each owning its OWN PlaneGeometry — so all our geometry (dome, discs, bodies,
      // star/Milky-Way points) is safe to free here; the guard only matters if a sprite ever slips in.
      if (o.geometry && !o.isSprite) o.geometry.dispose();
      const mat = o.material;
      if (mat) {
        if (mat.map && mat.map.userData?.proceduralSkyTexture) mat.map.dispose();
        mat.dispose();
      }
    });
  }

  function rebuild(r) {
    const nr = r ?? skyRadius(camera.far, size);
    _pending.push({ root: detachAll(), age: 0 });   // swap first; free the old tree later
    radius = nr;
    build();
  }

  return {
    group,
    // TSL: the dome colour along a unit direction node, live with time of day (water reflections).
    colorAlong(dirNode) { return skyColorAlong(domeU, dirNode); },
    setSunDir(v) {
      dir.copy(v).normalize(); domeU.sunDir.value.copy(dir);
      if (sunSprite) placeDisc(sunSprite, dir);
      if (!moonDir && moonSprite) placeDisc(moonSprite, dir); // back-compat: no independent moon dir yet
    },
    // Time-of-day: independent moon direction — does not move the sun sprite.
    setMoonDir(v) { moonDir = (moonDir || new THREE.Vector3()).copy(v).normalize(); placeMoon(); },
    get moonDir() { return moonDir ? moonDir.clone() : null; },
    // Explicit per-disc visibility for an external driver, bypassing setCelestialType/updateDiscVisibility.
    setCelestialVisibility(sunVisible, moonVisible) {
      celestialVisible = { sun: !!sunVisible, moon: !!moonVisible };
      updateDiscVisibility();
    },
    setDomeVisible(on) { componentVisible.dome = !!on; if (dome) dome.visible = componentVisible.dome; },
    setStarsVisible(on) { componentVisible.stars = !!on; if (starsPoints) starsPoints.visible = componentVisible.stars; },
    setMilkyWayVisible(on) { componentVisible.milkyWay = !!on; if (milkyWayGroup) milkyWayGroup.visible = componentVisible.milkyWay; },
    setBodiesVisible(on) { componentVisible.bodies = !!on; if (bodiesGroup) bodiesGroup.visible = componentVisible.bodies; },
    // Time-of-day: blend the dome to the given sun elevation (degrees). Uniform writes only.
    updateDome(elevDeg) { applyDome(elevDeg); },
    // When true, celestial (stars/Milky Way/bodies) opacity is multiplied by nightness.
    setCelestialOpacityMode(on) { celestialFollowTime = !!on; },
    setStableCelestialLayering(on) {
      stableCelestialLayering = !!on;
      bodiesGroup?.userData.setStableLayering?.(stableCelestialLayering);
    },
    // Directional horizon glow: 0 = even ring, 1 = fully concentrated toward the sun.
    setGlowDirectionality(v) { domeU.glowDirectionality.value = v; },
    // Overcast lid. Also reaches anything reflecting the dome through skyColorAlong (e.g. water).
    setOvercast(v) { domeU.overcast.value = Math.max(0, Math.min(1, v)); },
    setOvercastColor(c) { domeU.overcastColor.value.set(c); },
    get overcast() { return domeU.overcast.value; },
    get nightness() { return _nightness; },
    get skyStates() { return skyStates; },
    get thresholds() { return thresholds; },
    setPalette(o) { palette = makePalette(o); rebuild(radius); },
    // Sun/Moon switch is a pure visibility toggle — no rebuild, no disposal.
    setCelestialType(type) { palette.celestialType = type; updateDiscVisibility(); },
    // In-place runtime controls — NO rebuild/disposal (the slider-rebuild crash fix):
    // Persist into palette (as well as the live draw-range / uniform) so a seed rebuild,
    // which re-runs build() from the palette, keeps the current count/intensity.
    setStarCount(n) { palette.starCount = Math.max(0, n | 0); if (starsPoints) starsPoints.geometry.setDrawRange(0, Math.min(palette.starCount, starsMax)); },
    // Foreground-star brightness + color are live uniforms (no rebuild), same as Milky Way intensity.
    setStarOpacity(v) { palette.starOpacity = v; if (starsPoints && starsPoints.material._uOpacity) starsPoints.material._uOpacity.value = v; },
    setStarColor(hex) { palette.starColor = hex; if (starsPoints && starsPoints.material._uColor) starsPoints.material._uColor.value.set(hex); },
    setSunSize(v) { palette.sunSize = v; placeSun(); },
    setMoonSize(v) { palette.moonSize = v; placeSun(); },
    // Disc colour repaints the existing canvas + re-uploads (needsUpdate) — no dispose, no rebuild.
    setSunColor(hex) { palette.sun = hex; if (sunSprite) { paintSkyDiscCanvas(sunSprite.material.map.image, hex, false); sunSprite.material.map.needsUpdate = true; } },
    setMoonColor(hex) { palette.moonColor = hex; if (moonSprite) { paintSkyDiscCanvas(moonSprite.material.map.image, hex, true); moonSprite.material.map.needsUpdate = true; } },
    setSunOpacity(v) { palette.sunOpacity = v; if (sunSprite) sunSprite.material.opacity = v; },
    setMoonOpacity(v) { palette.moonOpacity = v; if (moonSprite) moonSprite.material.opacity = v; },
    setMilkyWayIntensity(v) { palette.milkyWayIntensity = v; if (milkyGas && milkyGas.material._uIntensity) milkyGas.material._uIntensity.value = v; },
    // New sky: re-roll every generator from a fresh base seed. Unlike the controls above this
    // DOES rebuild (the seed changes generated geometry), which is safe here because it's a
    // discrete call — not a per-frame slider drag — so detach + age-gated disposal frees the
    // old tree only after the in-flight submit ends.
    setSeed(n) { palette.seed = (n >>> 0) || 1; rebuild(radius); },
    // View-distance / chunk-size changes resize the sky by SCALING the group (the whole
    // sky is radius-relative) — no geometry rebuild, no disposal, so it can't race a submit.
    // skyRadius is clamped to camera.far*0.88, so the scaled dome never crosses the far plane.
    // `radius` overrides the size-derived default (pages with far terrain pin the sky to the far plane).
    setRadius(radius) { group.scale.setScalar((radius ?? skyRadius(camera.far, size)) / builtRadius); },
    rebuild,
    update(/* seconds */) { /* twinkle/gas animate on the GPU via the `time` node */ },
    // Free trees that have aged out (≥2 frames since detach → no submit references them).
    flushDisposals() {
      for (let i = _pending.length - 1; i >= 0; i--) {
        if (++_pending[i].age >= 2) { disposeTree(_pending[i].root); _pending.splice(i, 1); }
      }
    },
    dispose() { disposeTree(detachAll()); group.removeFromParent(); },
    get radius() { return radius; },
    get isMoon() { return isMoonBody(palette); },
  };
}

function parse(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function c8(v) { return Math.max(0, Math.min(255, v | 0)); }
function lighten(hex, t) { const [r, g, b] = parse(hex); return `rgb(${c8(r + (255 - r) * t)},${c8(g + (255 - g) * t)},${c8(b + (255 - b) * t)})`; }
function darken(hex, t) { const [r, g, b] = parse(hex); return `rgb(${c8(r * (1 - t))},${c8(g * (1 - t))},${c8(b * (1 - t))})`; }
function hexA(color, a) { if (color.startsWith('rgb')) return color.replace('rgb(', 'rgba(').replace(')', `,${a})`); const [r, g, b] = parse(color); return `rgba(${r},${g},${b},${a})`; }
