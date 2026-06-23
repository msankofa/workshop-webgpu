// sky.js
// Owner module for the WebGPU procedural sky: a camera-following group holding a gradient
// sky dome, the primary sun/moon sprite (locked to the scene light direction), and the
// composed star field + Milky Way + extra celestial bodies. Pure math is in sky-field.js;
// this file builds node materials + canvas textures and manages the lifecycle.
import * as THREE from 'three';
import { MeshBasicNodeMaterial, SpriteNodeMaterial } from 'three/webgpu';
import { Fn, float, vec3, mix, smoothstep, positionLocal, normalize, pow, max, abs } from 'three/tsl';
import { makePalette, skyRadius, isMoonBody, sunSpritePlacement, makeRng,
  generateStars, generateMilkyWay, generateCelestialBodies } from './sky-field.js';
import { createSkyStars, createMilkyWay } from './stars.js';
import { createCelestialBodies } from './celestial-bodies.js';

const _c = hex => new THREE.Color(hex);
const v3 = c => vec3(c.r, c.g, c.b);

// Gradient dome: bottom→horizon→top by view-direction Y, plus a horizon glow band.
function makeSkyDomeMaterial(palette) {
  const mat = new MeshBasicNodeMaterial({ side: THREE.BackSide, depthTest: false, depthWrite: false });
  mat.fog = false;
  const top = _c(palette.top), hor = _c(palette.horizon), bot = _c(palette.bottom), glow = _c(palette.glow);
  mat.colorNode = Fn(() => {
    const y = normalize(positionLocal).y;                       // -1 (down) .. 1 (up)
    const up = smoothstep(0.0, 0.55, y);                        // horizon → zenith
    const down = smoothstep(0.0, -0.5, y);                      // horizon → nadir
    const aboveCol = mix(v3(hor), v3(top), up);
    const belowCol = mix(v3(hor), v3(bot), down);
    const base = mix(aboveCol, belowCol, smoothstep(0.05, -0.05, y));  // soft horizon crossover
    const glowBand = pow(max(float(1).sub(abs(y).mul(9.0)), float(0)), float(2.0)); // tight horizon glow
    return mix(base, v3(glow), glowBand.mul(0.4));
  })();
  return mat;
}

// 256² sun (warm disc + corona) or 512² moon (glow + shaded sphere + maria).
function makeSkySunTexture(color, { moon }) {
  const S = moon ? 512 : 256;
  const cv = document.createElement('canvas'); cv.width = cv.height = S;
  const g = cv.getContext('2d');
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
  const tex = new THREE.CanvasTexture(cv);
  tex.userData.proceduralSkyTexture = true; tex.colorSpace = THREE.SRGBColorSpace; tex.needsUpdate = true;
  return tex;
}

export function createSky({ scene, camera, size, palette: overrides, sunDir, parts = {} }) {
  let palette = makePalette(overrides);
  const group = new THREE.Group();
  group.userData.followCamera = true;
  let radius = skyRadius(camera.far, size);
  let dir = (sunDir || new THREE.Vector3(0.6, 0.55, 0.58)).clone().normalize();

  let dome, sunSprite, moonSprite;

  function build() {
    // dome
    dome = new THREE.Mesh(new THREE.SphereGeometry(radius, 40, 18), makeSkyDomeMaterial(palette));
    dome.renderOrder = -1000; dome.frustumCulled = false;
    group.add(dome);
    // Build BOTH the sun disc and the moon disc up front. Switching between them is a
    // visibility toggle (see setCelestialType) — NOT a rebuild — so the Sun/Moon control
    // never disposes/recreates GPU resources mid-render (the cause of the night freeze).
    sunSprite  = makeDisc(palette.sun,       false);
    moonSprite = makeDisc(palette.moonColor, true);
    group.add(sunSprite, moonSprite);
    updateDiscVisibility();
    placeSun();
    // stars (parts.* let the viewer bisect which object triggers a GPU error)
    if (parts.stars !== false) {
      const rng = makeRng((palette.starCount | 0) ^ 0x5a17);
      group.add(createSkyStars(generateStars(radius, palette, rng), palette));
    }
    // milky way
    if (parts.milkyWay !== false) {
      const milky = createMilkyWay(generateMilkyWay(radius, palette, makeRng(0xb1a5)), palette);
      if (milky) group.add(milky);
    }
    // celestial bodies (night/dusk only — gate on milkyWay flag as the night marker)
    if (parts.bodies !== false && palette.milkyWay) {
      group.add(createCelestialBodies(generateCelestialBodies(radius, palette, makeRng(0xc0de))));
    }
    if (scene) scene.background = _c(palette.bottom);
  }

  function makeDisc(color, moon) {
    const tex = makeSkySunTexture(color, { moon });
    const m = new SpriteNodeMaterial({ map: tex, transparent: true, depthWrite: false });
    m.fog = false;
    const spr = new THREE.Sprite(m);
    spr.renderOrder = -996;
    spr.userData.moon = moon;
    return spr;
  }

  function updateDiscVisibility() {
    const moon = isMoonBody(palette);
    if (sunSprite)  sunSprite.visible  = !moon;
    if (moonSprite) moonSprite.visible = moon;
  }

  function placeDisc(spr) {
    const p = sunSpritePlacement([dir.x, dir.y, dir.z], radius, { ...palette, celestialType: spr.userData.moon ? 'moon' : 'sun' });
    spr.position.set(p.position.x, p.position.y, p.position.z);
    spr.scale.set(p.scale, p.scale, 1);
  }
  function placeSun() { if (sunSprite) placeDisc(sunSprite); if (moonSprite) placeDisc(moonSprite); }

  build();

  function detachAll() {
    // Reparent the live children into a throwaway group (does NOT touch the GPU).
    const old = new THREE.Group();
    for (let i = group.children.length - 1; i >= 0; i--) old.add(group.children[i]);
    return old;
  }

  // Disposal is queued, never run inline or from a bare rAF (both can race an in-flight
  // WebGPU submit → "Buffer used in submit while destroyed"). The viewer drains the queue
  // via flushDisposals() at a safe point in its loop (after the frame's render), when the
  // detached objects are guaranteed not to be referenced by any pending submit.
  const _pending = [];
  function disposeTree(root) {
    root.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      const mat = o.material;
      if (mat) {
        if (mat.map && mat.map.userData?.proceduralSkyTexture) mat.map.dispose();
        mat.dispose();
      }
    });
  }

  function rebuild(r) {
    const nr = r ?? skyRadius(camera.far, size);
    _pending.push(detachAll());   // swap first: build the new sky, dispose the old later
    radius = nr;
    build();
  }

  return {
    group,
    setSunDir(v) { dir.copy(v).normalize(); placeSun(); },
    setPalette(o) { palette = makePalette(o); rebuild(radius); },
    // Sun/Moon switch is a pure visibility toggle — no rebuild, no disposal.
    setCelestialType(type) { palette.celestialType = type; updateDiscVisibility(); },
    rebuild,
    update(/* seconds */) { /* twinkle/gas animate on the GPU via the `time` node */ },
    flushDisposals() { while (_pending.length) disposeTree(_pending.pop()); },
    dispose() { _pending.push(detachAll()); this.flushDisposals(); group.removeFromParent(); },
    get radius() { return radius; },
    get isMoon() { return isMoonBody(palette); },
  };
}

function parse(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function c8(v) { return Math.max(0, Math.min(255, v | 0)); }
function lighten(hex, t) { const [r, g, b] = parse(hex); return `rgb(${c8(r + (255 - r) * t)},${c8(g + (255 - g) * t)},${c8(b + (255 - b) * t)})`; }
function darken(hex, t) { const [r, g, b] = parse(hex); return `rgb(${c8(r * (1 - t))},${c8(g * (1 - t))},${c8(b * (1 - t))})`; }
function hexA(color, a) { if (color.startsWith('rgb')) return color.replace('rgb(', 'rgba(').replace(')', `,${a})`); const [r, g, b] = parse(color); return `rgba(${r},${g},${b},${a})`; }
