// grass.js
// Stylized wind-blown grass for three.js, ported from James-Smyth/three-grass-demo
// (https://github.com/James-Smyth/three-grass-demo) and adapted to this project.
//
// The whole field is ONE merged BufferGeometry: every blade is 5 vertices / 3
// triangles. A per-vertex weight (0 at the base, 0.5 mid, 1 at the tip) drives a
// sine wind wave in the vertex shader, so the base stays planted while the tip
// sways most. Unlike the original demo this is texture-free: the colour is a
// procedural base->tip gradient with a scrolling value-noise "cloud shadow" and
// a cheap flat lit tint, so it needs no asset files and works over file://.
//
// Usage from a host script:
//   import { createGrass } from './grass.js';
//   const grass = createGrass({ count: 40000, radius: 16, heightFn: terrainHeight });
//   scene.add(grass);
//   // each frame:
//   grass.update(performance.now() / 1000);   // seconds; drives the wind
//   // later:
//   grass.regenerate({ count: 80000 });       // rebuild geometry
//   grass.setWind(1.5);                        // live wind strength multiplier

import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  uniform, attribute, positionLocal, positionWorld, cameraPosition, modelWorldMatrix,
  Fn, vec2, vec3, vec4, float,
  sin, mix, clamp, distance, step, floor, fract, dot, max,
} from 'three/tsl';

// ---------- seeded RNG (mulberry32) so a seed reproduces the same field ----------
function makeRNG(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEFAULTS = {
  seed: 1,
  count: 40000,            // number of blades
  size: 0,                 // if > 0, scatter over a square of this full extent (XZ), centred on origin
  radius: 16,              // else scatter across a disk of this radius (XZ)
  bladeWidth: 0.1,         // width at the base
  bladeHeight: 0.8,        // base height before variation
  heightVariation: 0.6,    // random extra height added per blade (0..this)
  tipOffset: 0.1,          // how far the tip leans from the base centre
  baseColor: 0x16240e,     // dark green at the blade base (also reads as ambient occlusion)
  tipColor: 0x5a8a32,      // brighter green at the tip
  ambient: 0.55,           // flat ambient term
  key: 0.55,               // flat key-light term (grass uses a constant up-ish normal)
  waterLevel: null,        // if set, skip blades whose terrain base is below water (keeps grass off lakebeds)
  shoreMargin: 0.1,        // extra height above waterLevel a base must clear, so grass keeps off the waterline
  windSpeed: 2.0,          // wave temporal frequency (radians/sec)
  waveSize: 10.0,          // wave spatial frequency across the field
  tipDistance: 0.3,        // max sway of tip vertices
  centerDistance: 0.1,     // max sway of mid vertices
  cloudScale: 0.15,        // spatial scale of the scrolling cloud-shadow noise
  cloudStrength: 0.35,     // 0..1 darkening from cloud shadows
  cloudSpeed: 0.02,        // how fast the cloud shadows scroll
  // Distance fade defaults are "off": 1e6 units from the camera is effectively
  // never, and the +1 is just a non-zero band width to avoid a divide-by-zero.
  // The host overrides these via setFade() with real view-distance values.
  fadeStart: 1e6,          // world distance from camera where blades start shrinking
  fadeEnd: 1e6 + 1,        // world distance where blades are fully collapsed
  heightFn: null,          // optional (x, z) => y to conform blade bases to terrain
};

// deep-merge user options over defaults (arrays/primitives replace; objects merge)
function merge(base, over) {
  if (over == null) return base;
  const out = {};
  for (const k of new Set([...Object.keys(base), ...Object.keys(over)])) {
    const b = base[k], o = over[k];
    out[k] = (o !== undefined) ? o : b;
  }
  return out;
}

// per-blade vertex layout: [BL, BR, TR, TL, TC]
//   BL/BR = base corners, TR/TL = mid corners, TC = tip
const WIND_WEIGHT = [0.0, 0.0, 0.5, 0.5, 1.0]; // 0 base, 0.5 mid, 1 tip
const BLADE_INDICES = [0, 1, 2, 2, 4, 3, 3, 0, 2];

// ---- GLSL reference shaders (behavioral spec; kept for parity documentation) ----
// These were the original ShaderMaterial sources. The TSL node graph below
// reproduces the same logic — see the correspondence table in the commit message.
const VERT_SHADER = /* glsl */`
  attribute float aWind;
  attribute float aHeight;    // this vertex's height above its blade base (0 at base, blade height at tip)
  uniform float uTime;
  uniform float uWindSpeed;
  uniform float uWaveSize;
  uniform float uTipDistance;
  uniform float uCenterDistance;
  uniform float uCloudSpeed;
  uniform float uInvExtent;   // 1 / field extent; maps world XZ into the per-field 0..1 wind space
  uniform float uFadeStart;   // world distance from camera where blades begin shrinking
  uniform float uFadeEnd;     // world distance where blades are fully collapsed to the ground
  varying float vWind;
  varying vec2 vCloudUv;

  #include <shadowmap_pars_vertex>

  void main() {
    vWind = aWind;
    vec3 cpos = position;
    // Phase the wind on WORLD position (not the per-chunk local UV) so neighbouring
    // chunks share one continuous wave instead of each restarting a 0..1 pattern and
    // seaming at the shared edge. Every chunk uses the same extent + wave size, so
    // uWaveSize * uInvExtent is a constant world-space frequency across all chunks.
    vec3 worldBase = (modelMatrix * vec4(position, 1.0)).xyz;
    float wave = sin(uTime * uWindSpeed + worldBase.x * uWaveSize * uInvExtent);
    if (aWind > 0.6) {
      cpos.x += wave * uTipDistance;
    } else if (aWind > 0.0) {
      cpos.x += wave * uCenterDistance;
    }
    // Seamless distance LOD: shrink each blade toward its own base as it gets far
    // from the camera, using the vertex's TRUE world distance — so grass thins as a
    // smooth ring around the camera with no chunk-aligned steps. aHeight is the
    // vertex's height above its base; collapsing it leaves the base planted.
    float camDist = distance(worldBase.xz, cameraPosition.xz);
    float keep = 1.0 - clamp((camDist - uFadeStart) / max(0.001, uFadeEnd - uFadeStart), 0.0, 1.0);
    cpos.y -= aHeight * (1.0 - keep);
    // Cloud-shadow term keyed off world XZ too, so its drift is seamless across chunks.
    vCloudUv = worldBase.xz * uInvExtent + vec2(uTime * uCloudSpeed, uTime * uCloudSpeed * 0.5);
    vec4 worldPosition = modelMatrix * vec4(cpos, 1.0);
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
    // shadowmap_vertex requires transformedNormal which grass lacks; assign coords directly
    #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    #pragma unroll_loop_start
    for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
      vDirectionalShadowCoord[ i ] = directionalShadowMatrix[ i ] * worldPosition;
    }
    #pragma unroll_loop_end
    #endif
  }
`;

const FRAG_SHADER = /* glsl */`
  precision highp float;
  uniform vec3 uBaseColor;
  uniform vec3 uTipColor;
  uniform float uAmbient;
  uniform float uKey;
  uniform float uCloudScale;
  uniform float uCloudStrength;
  varying float vWind;
  varying vec2 vCloudUv;

  #include <packing>
  #include <shadowmap_pars_fragment>

  // cheap 2D value noise for the drifting cloud-shadow term
  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    float a = hash(i), b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  void main() {
    vec3 col = mix(uBaseColor, uTipColor, vWind);
    float light = uAmbient + uKey;
    float cloud = 1.0 - uCloudStrength * noise(vCloudUv * uCloudScale * 64.0);

    float shadow = 1.0;
    #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
      shadow = getShadow(
        directionalShadowMap[ 0 ],
        directionalLightShadows[ 0 ].shadowMapSize,
        directionalLightShadows[ 0 ].shadowBias,
        directionalLightShadows[ 0 ].shadowRadius,
        vDirectionalShadowCoord[ 0 ]
      );
    #endif

    gl_FragColor = vec4(col * light * cloud * shadow, 1.0);
  }
`;

// ---- JS-side parity helpers (mirror of GLSL wind/fade math; used by tests) ----

/**
 * Returns the wind X-offset wave value for a vertex at the given world X position.
 * Matches: sin(uTime * uWindSpeed + worldBase.x * uWaveSize * uInvExtent) in VERT_SHADER.
 * Phased on world X so neighbouring chunks share one continuous wave (no seam).
 */
export function grassWindOffset(worldX, uTime, uWindSpeed, uWaveSize, uInvExtent) {
  return Math.sin(uTime * uWindSpeed + worldX * uWaveSize * uInvExtent);
}

/**
 * Returns the `keep` factor (1 = full height, 0 = collapsed to base) for a blade
 * vertex at the given camera distance.
 * Matches: 1.0 - clamp((camDist - uFadeStart) / max(0.001, uFadeEnd - uFadeStart), 0.0, 1.0)
 */
export function grassFadeKeep(camDist, start, end) {
  const range = Math.max(0.001, end - start);
  return 1 - Math.max(0, Math.min(1, (camDist - start) / range));
}

function buildGeometry(o) {
  const rng = makeRNG(o.seed);
  const n = Math.max(0, Math.floor(o.count));
  const heightFn = o.heightFn || (() => 0);
  const R = o.radius;
  const useSquare = o.size > 0;
  // UVs (and the cloud-shadow noise) map the field into 0..1 over its full extent:
  // the square's side, or the disk's diameter.
  const invExtent = 1 / (useSquare ? o.size : 2 * R);
  const halfW = o.bladeWidth * 0.5, midW = o.bladeWidth * 0.25;

  // minimum terrain height a blade base must clear; bases below this (lakebeds,
  // shoreline) are rejected so grass keeps out of the water.
  const minBaseY = (o.waterLevel != null) ? o.waterLevel + o.shoreMargin : -Infinity;

  const positions = new Float32Array(n * 5 * 3);
  const uvs = new Float32Array(n * 5 * 2);
  const winds = new Float32Array(n * 5);
  const heights = new Float32Array(n * 5);   // per-vertex height above blade base, for distance fade
  const indices = new Uint32Array(n * 9);

  // Fixed number of placement attempts (= the target count), NOT a refill-to-n
  // loop. Underwater/shoreline samples are dropped as gaps instead of being
  // retried, so blade density on land is uniform across chunks regardless of how
  // much of a chunk is lake. (Refilling to a fixed count packed the same blades
  // into whatever land remained, making partly-flooded chunks visibly denser.)
  let m = 0; // blades actually placed (<= n; water carves the count down)
  for (let attempt = 0; attempt < n; attempt++) {
    // scatter the blade base: uniform over the square, or equal-area over the disk
    let bx, bz;
    if (useSquare) {
      bx = (rng() - 0.5) * o.size;
      bz = (rng() - 0.5) * o.size;
    } else {
      const r = R * Math.sqrt(rng());
      const theta = rng() * Math.PI * 2;
      bx = Math.cos(theta) * r; bz = Math.sin(theta) * r;
    }
    const by = heightFn(bx, bz);
    if (by < minBaseY) continue; // submerged / on the waterline — skip this spot

    const h = o.bladeHeight + rng() * o.heightVariation;
    const yaw = rng() * Math.PI * 2;
    const dx = Math.sin(yaw), dz = -Math.cos(yaw);          // blade width axis
    const tipYaw = rng() * Math.PI * 2;
    const tdx = Math.sin(tipYaw), tdz = -Math.cos(tipYaw);  // independent tip lean

    const u = bx * invExtent + 0.5, vv = bz * invExtent + 0.5;

    // [BL, BR, TR, TL, TC]
    const ox = [dx * -halfW, dx * halfW, dx * midW, dx * -midW, tdx * o.tipOffset];
    const oz = [dz * -halfW, dz * halfW, dz * midW, dz * -midW, tdz * o.tipOffset];
    const oy = [0, 0, h * 0.5, h * 0.5, h];

    const vBase = m * 5;
    for (let k = 0; k < 5; k++) {
      const p = (vBase + k) * 3;
      positions[p]     = bx + ox[k];
      positions[p + 1] = by + oy[k];
      positions[p + 2] = bz + oz[k];
      const q = (vBase + k) * 2;
      uvs[q] = u; uvs[q + 1] = vv;
      winds[vBase + k] = WIND_WEIGHT[k];
      heights[vBase + k] = oy[k];
    }
    const iBase = m * 9;
    for (let k = 0; k < 9; k++) indices[iBase + k] = vBase + BLADE_INDICES[k];
    m++;
  }

  // Trim to the blades actually placed (water rejection may leave m < n).
  const pos = (m === n) ? positions : positions.subarray(0, m * 5 * 3);
  const uv  = (m === n) ? uvs       : uvs.subarray(0, m * 5 * 2);
  const wnd = (m === n) ? winds     : winds.subarray(0, m * 5);
  const hgt = (m === n) ? heights   : heights.subarray(0, m * 5);
  const idx = (m === n) ? indices   : indices.subarray(0, m * 9);

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geom.setAttribute('aWind', new THREE.BufferAttribute(wnd, 1));
  geom.setAttribute('aHeight', new THREE.BufferAttribute(hgt, 1));
  geom.setIndex(new THREE.BufferAttribute(idx, 1));
  geom.computeBoundingSphere();
  return geom;
}

// ---- TSL node material ----
//
// GLSL → TSL correspondence:
//
//  VERT_SHADER worldBase = modelMatrix * position
//    → modelWorldMatrix.mul(vec4(positionLocal, 1.0)).xyz           (positionLocal is pre-displacement)
//
//  wave = sin(uTime * uWindSpeed + worldBase.x * uWaveSize * uInvExtent)
//    → sin(uTime.mul(uWindSpeed).add(worldPos.x.mul(uWaveSize).mul(uInvExtent)))  [SEAM FIX PRESERVED]
//
//  if (aWind > 0.6) sway = uTipDistance; else if (aWind > 0.0) sway = uCenterDistance;
//    → isMidOrTip = step(0.001, aWind); isTip = step(0.601, aWind)
//      swayAmt = isMidOrTip.mul(mix(uCenterDist, uTipDist, isTip))
//
//  cpos.y -= aHeight * (1.0 - keep)  where keep = 1 - clamp((camDist-fadeStart)/range, 0, 1)
//    → positionLocal.y.sub(aHeight.mul(float(1).sub(keep)))
//
//  positionNode = vec3(positionLocal.x + windX, positionLocal.y - fadeY, positionLocal.z)
//
//  FRAG_SHADER: col = mix(uBaseColor, uTipColor, vWind)
//    → mix(uBaseColor, uTipColor, aWind)   [TSL auto-creates varying for attribute in fragment stage]
//
//  hash(p) / noise(p) — value-noise cloud shadow
//    → hash2D / noise2D TSL Fn nodes (exact same formula)
//
//  vCloudUv = worldBase.xz * uInvExtent + scroll
//    → positionWorld.xz.mul(uInvExtent).add(scroll)
//      [uses displaced world pos; max shift < 0.09 noise-units — imperceptible at cloud scale]
//
//  gl_FragColor = col * (uAmbient + uKey) * cloud * shadow
//    → colorNode = mix(...).mul(uAmbient.add(uKey)).mul(cloud)
//      [MeshStandardNodeMaterial's PBR lighting + shadow system handles real scene shadows]

function buildMaterial(o) {
  const invExtent = 1 / (o.size > 0 ? o.size : 2 * o.radius);

  // ---- Uniform handles (stored on the material for live updates via public API) ----
  const uTime          = uniform(0.0,               'float');
  const uWindSpeed     = uniform(o.windSpeed,        'float');
  const uWaveSize      = uniform(o.waveSize,         'float');
  const uTipDist       = uniform(o.tipDistance,      'float');
  const uCenterDist    = uniform(o.centerDistance,   'float');
  const uInvExtent     = uniform(invExtent,          'float');
  const uFadeStart     = uniform(o.fadeStart,        'float');
  const uFadeEnd       = uniform(o.fadeEnd,          'float');
  const uBaseColor     = uniform(new THREE.Color(o.baseColor));
  const uTipColor      = uniform(new THREE.Color(o.tipColor));
  const uAmbient       = uniform(o.ambient,          'float');
  const uKey           = uniform(o.key,              'float');
  const uCloudScale    = uniform(o.cloudScale,       'float');
  const uCloudStrength = uniform(o.cloudStrength,    'float');
  const uCloudSpeed    = uniform(o.cloudSpeed,       'float');

  // ---- Per-vertex attributes ----
  const aWind   = attribute('aWind',   'float');
  const aHeight = attribute('aHeight', 'float');

  // ---- positionNode: wind sway + distance fade ----
  // Compute world position from the ORIGINAL local position (before any displacement)
  // so the wind phase is continuous across chunk boundaries (the seam fix).
  const worldPos4 = modelWorldMatrix.mul(vec4(positionLocal, 1.0));
  const worldPos  = worldPos4.xyz;

  // Wind wave phased on WORLD X — continuous across chunks
  const wave = sin(
    uTime.mul(uWindSpeed).add(worldPos.x.mul(uWaveSize).mul(uInvExtent))
  );

  // Sway amplitude per wind weight:
  //   base  (aWind = 0.0): no sway
  //   mid   (aWind = 0.5): uCenterDist
  //   tip   (aWind = 1.0): uTipDist
  const isMidOrTip = step(float(0.001), aWind);   // 1 for mid+tip, 0 for base
  const isTip      = step(float(0.601), aWind);   // 1 for tip only
  const swayAmt    = isMidOrTip.mul(mix(uCenterDist, uTipDist, isTip));
  const windX      = wave.mul(swayAmt);

  // Distance fade: collapse each blade toward its base as it recedes from camera
  const camDist   = distance(worldPos.xz, cameraPosition.xz);
  const fadeRange = max(float(0.001), uFadeEnd.sub(uFadeStart));
  const keep      = float(1.0).sub(
    clamp(camDist.sub(uFadeStart).div(fadeRange), 0.0, 1.0)
  );
  const fadeY = aHeight.mul(float(1.0).sub(keep));

  // Displaced local position
  const posNode = vec3(
    positionLocal.x.add(windX),
    positionLocal.y.sub(fadeY),
    positionLocal.z
  );

  // ---- colorNode: base→tip gradient × flat light × cloud shadow ----

  // Value-noise hash — matches GLSL:  fract(fract(p * vec2(123.34, 456.21)) dot-product)
  const hash2D = Fn(([p]) => {
    const q = fract(p.mul(vec2(123.34, 456.21)));
    const r = q.add(dot(q, q.add(float(45.32))));
    return fract(r.x.mul(r.y));
  });

  // Bilinear value noise — matches GLSL noise(p)
  const noise2D = Fn(([p]) => {
    const i = floor(p);
    const f = fract(p);
    const a = hash2D(i);
    const b = hash2D(i.add(vec2(1.0, 0.0)));
    const c = hash2D(i.add(vec2(0.0, 1.0)));
    const d = hash2D(i.add(vec2(1.0, 1.0)));
    // Hermite smoothstep: u = f*f*(3-2*f)
    const u = f.mul(f).mul(float(3.0).sub(f.mul(2.0)));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  });

  // Cloud UV: world XZ scaled by invExtent, scrolling over time.
  // positionWorld.xz is post-displacement; max wind shift < 0.09 noise-units (imperceptible).
  const cloudUv = positionWorld.xz.mul(uInvExtent).add(
    vec2(uTime.mul(uCloudSpeed), uTime.mul(uCloudSpeed).mul(0.5))
  );
  const cloud = float(1.0).sub(
    uCloudStrength.mul(noise2D(cloudUv.mul(uCloudScale).mul(64.0)))
  );

  // Blade color: base→tip gradient, scaled by flat ambient+key, darkened by cloud shadow
  const grassColor = mix(uBaseColor, uTipColor, aWind);
  const colorNode  = grassColor.mul(uAmbient.add(uKey)).mul(cloud);

  // ---- Assemble material ----
  const mat = new MeshStandardNodeMaterial({
    side:      THREE.DoubleSide,
    roughness: 1.0,
    metalness: 0.0,
  });
  mat.positionNode = posNode;
  mat.colorNode    = colorNode;
  // Grass has no per-vertex normals and is a double-sided quad; without this,
  // MeshStandard derives a per-face normal and each blade/side lights differently
  // (alternating dark/light). A constant up normal matches the original GLSL's
  // flat "constant up-ish normal" so every blade is lit uniformly (shadows still apply).
  mat.normalNode   = vec3(0, 1, 0);

  // Store uniform handles on the material so Grass methods can update them live
  mat._uTime        = uTime;
  mat._uWindSpeed   = uWindSpeed;
  mat._uWaveSize    = uWaveSize;
  mat._uTipDist     = uTipDist;
  mat._uCenterDist  = uCenterDist;
  mat._uInvExtent   = uInvExtent;
  mat._uFadeStart   = uFadeStart;
  mat._uFadeEnd     = uFadeEnd;
  mat._uAmbient     = uAmbient;
  mat._uKey         = uKey;

  return mat;
}

export class Grass extends THREE.Mesh {
  constructor(options = {}) {
    const o = merge(DEFAULTS, options);
    super(buildGeometry(o), buildMaterial(o));
    this.options = o;
    this.frustumCulled = false; // one big mesh spanning the field; keep it drawn
    this.castShadow = false;
    this.receiveShadow = true;
  }

  // advance the wind animation; `seconds` is elapsed time (e.g. performance.now()/1000)
  update(seconds) {
    this.material._uTime.value = seconds;
  }

  setAmbient(v) { this.material._uAmbient.value = v; }
  setKey(v)     { this.material._uKey.value = v; }

  // live wind-strength multiplier (scales sway amplitude); no geometry rebuild
  setWind(strength) {
    this.material._uTipDist.value    = this.options.tipDistance    * strength;
    this.material._uCenterDist.value = this.options.centerDistance * strength;
  }

  // world-space distance fade: blades shrink between `start` and `end` distance
  // from the camera. start >= end (or huge) disables it. No geometry rebuild.
  setFade(start, end) {
    this.material._uFadeStart.value = start;
    this.material._uFadeEnd.value   = Math.max(start + 0.001, end);
  }

  // rebuild the field (e.g. after changing count/radius/seed)
  regenerate(options) {
    if (options) this.options = merge(this.options, options);
    this.geometry.dispose();
    this.geometry = buildGeometry(this.options);
    const o = this.options;
    this.material._uInvExtent.value = 1 / (o.size > 0 ? o.size : 2 * o.radius);
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

export function createGrass(options) {
  return new Grass(options);
}

export default Grass;
