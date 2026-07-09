// water.js
// Lake water for three.js, porting the real techniques of martinRenou/threejs-water
// (https://github.com/martinRenou/threejs-water) to heightfield-terrain lakes:
//
//   * Planar REFLECTION  - a mirrored camera with an oblique-clipped projection
//                          renders the scene into a texture (the THREE.Reflector
//                          algorithm), sampled projectively by the surface.
//   * Screen-space REFRACTION - the scene (water hidden) is rendered to a texture
//                          the surface samples, bent by the ripple normal.
//   * CAUSTICS           - the water grid is rendered from the light direction;
//                          each vertex's light ray is refracted (Snell) and
//                          projected onto the lakebed, and the ratio of the
//                          pre/post-refraction triangle area (screen-space
//                          derivatives) is the caustic intensity. The terrain
//                          material is patched (onBeforeCompile) to reverse-project
//                          along the refracted light and add that caustic light.
//
// Because lakes have no pool box, the demo's raytraced walls / ping-pong height
// simulation are replaced with analytic ripples and a reference bed plane, but the
// reflection and caustics math is the genuine article.
//
// Usage:
//   import { createWaterSystem } from './water.js';
//   const water = createWaterSystem({ renderer, scene, camera, ground,
//                                     size, waterLevel, heightFn });
//   scene.add(water.surface);
//   // each frame, BEFORE renderer.render(scene, camera):
//   water.update(performance.now() / 1000);

import * as THREE from 'three';
import { MeshBasicNodeMaterial, TextureNode, NodeUpdateType } from 'three/webgpu';
import {
  uniform, attribute, positionWorld, cameraPosition,
  Fn, vec2, vec3, vec4, float,
  sin, normalize, dot, pow, max, min, clamp, mix, smoothstep, step,
  length, dFdx, dFdy, varying, refract,
  positionGeometry, modelWorldMatrix,
  reflector, viewportSharedTexture, screenUV,
} from 'three/tsl';

export const WATER_VERSION = 'cw8';

const IOR_AIR = 1.0, IOR_WATER = 1.333, ETA = IOR_AIR / IOR_WATER;

const DEFAULTS = {
  renderer: null, scene: null, camera: null, ground: null,
  size: 60,
  segments: 0,
  waterLevel: -0.9,
  heightFn: null,
  lightDir: null,           // THREE.Vector3 toward the light; defaults to the key light
  shallow: 0x3f6f78,
  deep: 0x10333f,
  refractStrength: 0.12,
  reflectStrength: 0.08,
  reflectMix: 1.0,
  reflectBrightness: 1.0,
  reflectResolutionScale: 0.5, // perf: reflector render-target scale (1 = full res); see setReflectionTuning()
  reflectRate: 1,              // perf: render the reflection every Nth frame (1 = every frame)
  reflectExclude: null,        // Object3D/list/function returning detail objects hidden only during reflection
  depthScale: 3.0,
  waveStrength: 1.0,
  caustic: 1.0,
  causticBedDepth: 3.0,     // reference bed plane sits this far below the water level
  causticRes: 1024,
  causticRate: 1,           // perf: render the caustic pass every Nth frame (1 = every frame); see setCausticRate()
  buildBudgetMs: 1.5,
  maxBuildsPerFrame: 1,
  lodR0: 50,
  lodR1: 150,
  cellS0: 1,
  cellS1: 4,
  cellS2: 16,
  extentX: undefined,
  extentZ: undefined,
  deferredDisposeFrames: 4,
};

function merge(base, over) {
  if (over == null) return base;
  const out = {};
  for (const k of new Set([...Object.keys(base), ...Object.keys(over)])) {
    const o = over[k];
    out[k] = (o !== undefined) ? o : base[k];
  }
  return out;
}

// shared ripple height field (gradient -> surface normal); used by both passes
const WAVE_GLSL = /* glsl */`
  uniform float uTime;
  uniform float uWave;
  float waveH(vec2 p) {
    return sin(p.x * 0.8 + uTime * 1.3) * 0.05
         + sin(p.y * 0.7 - uTime * 1.1) * 0.05
         + sin((p.x + p.y) * 1.3 + uTime * 1.7) * 0.03;
  }
  vec3 rippleNormal(vec2 p) {
    float e = 0.15;
    float hx = waveH(p + vec2(e, 0.0)) - waveH(p - vec2(e, 0.0));
    float hz = waveH(p + vec2(0.0, e)) - waveH(p - vec2(0.0, e));
    return normalize(vec3(-hx * uWave, 2.0 * e, -hz * uWave));
  }
`;

const SURFACE_VERT = /* glsl */`
  attribute float aDepth;
  uniform mat4 uTextureMatrix;
  varying vec3 vWorld;
  varying float vDepth;
  varying vec4 vReflect;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vDepth = aDepth;
    vReflect = uTextureMatrix * wp;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const SURFACE_FRAG = /* glsl */`
  precision highp float;
  ${WAVE_GLSL}
  uniform sampler2D uRefract;
  uniform sampler2D uReflect;
  uniform vec2 uResolution;
  uniform vec3 uShallow;
  uniform vec3 uDeep;
  uniform vec3 uCamPos;
  uniform vec3 uLightDir;
  uniform float uRefractStrength;
  uniform float uReflectStrength;
  uniform float uDepthScale;
  varying vec3 vWorld;
  varying float vDepth;
  varying vec4 vReflect;

  void main() {
    vec3 N = rippleNormal(vWorld.xz);
    vec3 viewDir = normalize(uCamPos - vWorld);
    float fres = 0.02 + 0.98 * pow(1.0 - clamp(dot(N, viewDir), 0.0, 1.0), 3.0);
    float dt = clamp(vDepth / uDepthScale, 0.0, 1.0);

    // refraction of the lakebed (screen space)
    vec2 uv = gl_FragCoord.xy / uResolution;
    vec3 bed = texture2D(uRefract, uv + N.xz * uRefractStrength * dt).rgb;
    vec3 waterCol = mix(uShallow, uDeep, dt);
    vec3 refr = mix(bed, waterCol, mix(0.2, 0.85, dt));

    // planar reflection (projective sample, bent by the ripple)
    vec4 rc = vReflect;
    rc.xy += N.xz * uReflectStrength * rc.w;
    vec3 refl = texture2DProj(uReflect, rc).rgb;

    vec3 color = mix(refr, refl, fres);
    float spec = pow(max(dot(reflect(-uLightDir, N), viewDir), 0.0), 80.0);
    color += spec * vec3(1.0);

    float alpha = clamp(0.5 + vDepth, 0.6, 0.98) * smoothstep(0.0, 0.1, vDepth);
    gl_FragColor = vec4(color, alpha);
  }
`;

const CAUSTIC_VERT = /* glsl */`
  attribute float aDepth;
  ${WAVE_GLSL}
  uniform vec3 uLightDir;   // normalized, toward the light
  uniform float uEta;
  uniform float uBedRef;
  uniform float uWorldSize;
  uniform vec2 uWorldCenter;
  varying vec3 vOld;
  varying vec3 vNew;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vec3 P = wp.xyz;
    vec3 N = rippleNormal(P.xz);

    vec3 baseRay = refract(-uLightDir, vec3(0.0, 1.0, 0.0), uEta); // flat surface
    vec3 ray = refract(-uLightDir, N, uEta);                       // perturbed surface

    float tOld = (uBedRef - P.y) / baseRay.y;
    float tNew = (uBedRef - P.y) / ray.y;
    vOld = P + baseRay * tOld;
    vNew = P + ray * tNew;

    // top-down orthographic map over the world, indexed where the light lands
    gl_Position = vec4((vNew.xz - uWorldCenter) / (0.5 * uWorldSize), 0.0, 1.0);
  }
`;

const CAUSTIC_FRAG = /* glsl */`
  precision highp float;
  varying vec3 vOld;
  varying vec3 vNew;
  void main() {
    float oldArea = length(dFdx(vOld)) * length(dFdy(vOld));
    float newArea = length(dFdx(vNew)) * length(dFdy(vNew));
    gl_FragColor = vec4(oldArea / max(newArea, 1e-5) * 0.2, 1.0, 0.0, 1.0);
  }
`;

function buildGeometry(o, bounds = null) {
  const size = bounds ? bounds.size : o.size;
  const seg = o.segments > 0 ? o.segments : Math.max(16, Math.round(size * 1.4));
  const xMin = bounds ? bounds.xMin : -size / 2;
  const zMin = bounds ? bounds.zMin : -size / 2;
  const step = size / seg, nx = seg + 1;
  const heightFn = o.heightFn || (() => 0), level = o.waterLevel;

  const positions = new Float32Array(nx * nx * 3);
  const depths = new Float32Array(nx * nx);
  const bed = new Float32Array(nx * nx);
  const indices = [];
  let minBed = Infinity;

  for (let j = 0; j <= seg; j++) {
    for (let i = 0; i <= seg; i++) {
      const idx = j * nx + i;
      const x = xMin + i * step, z = zMin + j * step;
      const b = heightFn(x, z);
      minBed = Math.min(minBed, b);
      bed[idx] = b;
      positions[idx * 3] = x; positions[idx * 3 + 1] = 0; positions[idx * 3 + 2] = z;
      depths[idx] = Math.max(0, level - b);
    }
  }
  for (let j = 0; j < seg; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      if (bed[a] < level || bed[b] < level || bed[c] < level || bed[d] < level) {
        indices.push(a, c, b, b, c, d);
      }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('aDepth', new THREE.BufferAttribute(depths, 1));
  g.setIndex(indices);
  g.computeBoundingSphere();
  g.userData.minBed = minBed;
  return g;
}

function getChunkBounds(o) {
  if (Array.isArray(o.chunks) && o.chunks.length > 0) {
    return o.chunks.map(chunk => ({
      key: chunk.key,
      xMin: chunk.xMin,
      zMin: chunk.zMin,
      size: chunk.size,
    }));
  }
  const size = o.size;
  return [{ key: 'main', xMin: -size * 0.5, zMin: -size * 0.5, size }];
}

function getWorldProjection(bounds) {
  let xMin = Infinity, zMin = Infinity, xMax = -Infinity, zMax = -Infinity;
  for (const b of bounds) {
    xMin = Math.min(xMin, b.xMin);
    zMin = Math.min(zMin, b.zMin);
    xMax = Math.max(xMax, b.xMin + b.size);
    zMax = Math.max(zMax, b.zMin + b.size);
  }
  const size = Math.max(1, xMax - xMin, zMax - zMin);
  return {
    centerX: (xMin + xMax) * 0.5,
    centerZ: (zMin + zMax) * 0.5,
    size,
  };
}

function nowMs() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

function makeHeightCache() {
  return { map: new Map(), hits: 0, misses: 0 };
}

function sampleCachedHeight(o, cache, cellSize, x, z) {
  const qx = Math.round(x * 1000);
  const qz = Math.round(z * 1000);
  const key = `${cellSize}:${qx},${qz}`;
  const cached = cache.map.get(key);
  if (cached !== undefined) {
    cache.hits++;
    return cached;
  }
  const h = (o.heightFn || (() => 0))(x, z);
  cache.map.set(key, h);
  cache.misses++;
  return h;
}

function createRingGeometryJob(o, desc, heightCache) {
  const { snapX, snapZ, innerSnapX, innerSnapZ, innerHalf, outerHalf, cellSize, extentX, extentZ } = desc;
  const xMin = snapX - outerHalf;
  const zMin = snapZ - outerHalf;
  const nX = Math.max(1, Math.round((outerHalf * 2) / cellSize));
  const nZ = Math.max(1, Math.round((outerHalf * 2) / cellSize));
  const nx = nX + 1, nz = nZ + 1;
  const level = o.waterLevel;
  const positions = new Float32Array(nx * nz * 3);
  const depths = new Float32Array(nx * nz);
  const bed = new Float32Array(nx * nz);
  const indices = [];
  const extraPositions = [];
  const extraDepths = [];
  const eps = 1e-5;
  let minBed = Infinity;
  let vertexRow = 0;
  let indexRow = 0;
  let phase = 'vertices';
  const startedAt = nowMs();


  function addExtraVertex(x, z) {
    const h = sampleCachedHeight(o, heightCache, cellSize, x, z);
    minBed = Math.min(minBed, h);
    const index = nx * nz + extraDepths.length;
    extraPositions.push(x, 0, z);
    extraDepths.push(Math.max(0, level - h));
    return index;
  }

  function rectIsDry(x0, z0, x1, z1) {
    const h00 = sampleCachedHeight(o, heightCache, cellSize, x0, z0);
    const h10 = sampleCachedHeight(o, heightCache, cellSize, x1, z0);
    const h01 = sampleCachedHeight(o, heightCache, cellSize, x0, z1);
    const h11 = sampleCachedHeight(o, heightCache, cellSize, x1, z1);
    minBed = Math.min(minBed, h00, h10, h01, h11);
    return h00 >= level && h10 >= level && h01 >= level && h11 >= level;
  }

  function emitRect(x0, z0, x1, z1) {
    if (x1 - x0 <= eps || z1 - z0 <= eps) return;
    if (rectIsDry(x0, z0, x1, z1)) return;
    const a = addExtraVertex(x0, z0);
    const b = addExtraVertex(x1, z0);
    const c = addExtraVertex(x0, z1);
    const d = addExtraVertex(x1, z1);
    indices.push(a, c, b, b, c, d);
  }

  function step(deadlineMs) {
    const hasBudget = () => nowMs() < deadlineMs;
    if (phase === 'vertices') {
      do {
        for (let i = 0; i < nx; i++) {
          const idx = vertexRow * nx + i;
          const x = xMin + i * cellSize;
          const z = zMin + vertexRow * cellSize;
          const b = sampleCachedHeight(o, heightCache, cellSize, x, z);
          minBed = Math.min(minBed, b);
          bed[idx] = b;
          positions[idx * 3] = x;
          positions[idx * 3 + 1] = 0;
          positions[idx * 3 + 2] = z;
          depths[idx] = Math.max(0, level - b);
        }
        vertexRow++;
      } while (vertexRow < nz && hasBudget());
      if (vertexRow < nz) return false;
      phase = 'indices';
    }

    if (phase === 'indices') {
      do {
        for (let i = 0; i < nX; i++) {
          const cellX0 = xMin + i * cellSize;
          const cellZ0 = zMin + indexRow * cellSize;
          const cellX1 = cellX0 + cellSize;
          const cellZ1 = cellZ0 + cellSize;
          let rx0 = cellX0, rx1 = cellX1, rz0 = cellZ0, rz1 = cellZ1;
          if (extentX !== undefined) {
            rx0 = Math.max(rx0, -extentX * 0.5);
            rx1 = Math.min(rx1,  extentX * 0.5);
          }
          if (extentZ !== undefined) {
            rz0 = Math.max(rz0, -extentZ * 0.5);
            rz1 = Math.min(rz1,  extentZ * 0.5);
          }
          if (rx1 - rx0 <= eps || rz1 - rz0 <= eps) continue;

          const a = indexRow * nx + i, b = a + 1, c = a + nx, d = c + 1;
          const extentClipped = Math.abs(rx0 - cellX0) > eps || Math.abs(rx1 - cellX1) > eps
            || Math.abs(rz0 - cellZ0) > eps || Math.abs(rz1 - cellZ1) > eps;

          if (innerHalf <= 0) {
            if (extentClipped) emitRect(rx0, rz0, rx1, rz1);
            else if (!(bed[a] >= level && bed[b] >= level && bed[c] >= level && bed[d] >= level)) indices.push(a, c, b, b, c, d);
            continue;
          }

          const ix0 = innerSnapX - innerHalf;
          const ix1 = innerSnapX + innerHalf;
          const iz0 = innerSnapZ - innerHalf;
          const iz1 = innerSnapZ + innerHalf;
          const outsideInner = rx1 <= ix0 || rx0 >= ix1 || rz1 <= iz0 || rz0 >= iz1;
          if (outsideInner) {
            if (extentClipped) emitRect(rx0, rz0, rx1, rz1);
            else if (!(bed[a] >= level && bed[b] >= level && bed[c] >= level && bed[d] >= level)) indices.push(a, c, b, b, c, d);
            continue;
          }
          if (rx0 >= ix0 && rx1 <= ix1 && rz0 >= iz0 && rz1 <= iz1) continue;

          emitRect(rx0, rz0, Math.min(rx1, ix0), rz1);
          emitRect(Math.max(rx0, ix1), rz0, rx1, rz1);
          const mx0 = Math.max(rx0, ix0);
          const mx1 = Math.min(rx1, ix1);
          emitRect(mx0, rz0, mx1, Math.min(rz1, iz0));
          emitRect(mx0, Math.max(rz0, iz1), mx1, rz1);
        }
        indexRow++;
      } while (indexRow < nZ && hasBudget());
      if (indexRow < nZ) return false;
      phase = 'done';
    }
    return true;
  }

  function toGeometry() {
    const g = new THREE.BufferGeometry();
    let finalPositions = positions;
    let finalDepths = depths;
    if (extraDepths.length > 0) {
      finalPositions = new Float32Array(positions.length + extraPositions.length);
      finalPositions.set(positions);
      finalPositions.set(extraPositions, positions.length);
      finalDepths = new Float32Array(depths.length + extraDepths.length);
      finalDepths.set(depths);
      finalDepths.set(extraDepths, depths.length);
    }
    g.setAttribute('position', new THREE.BufferAttribute(finalPositions, 3));
    g.setAttribute('aDepth', new THREE.BufferAttribute(finalDepths, 1));
    g.setIndex(indices);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(snapX, 0, snapZ), Math.SQRT2 * outerHalf);
    g.userData.minBed = minBed;
    return g;
  }

  return {
    desc,
    get done() { return phase === 'done'; },
    get elapsedMs() { return nowMs() - startedAt; },
    step,
    toGeometry,
  };
}

// I.refract(N) per GLSL semantics, for the CPU-side flat refracted light
function refractVec(I, N, eta, out) {
  const dotNI = N.dot(I);
  const k = 1 - eta * eta * (1 - dotNI * dotNI);
  if (k < 0) return out.set(0, 0, 0);
  return out.copy(I).multiplyScalar(eta).addScaledVector(N, -(eta * dotNI + Math.sqrt(k)));
}

export function createWaterSystem(options = {}) {
  const o = merge(DEFAULTS, options);
  const { renderer, scene, camera, ground } = o;
  const lightDir = (o.lightDir ? o.lightDir.clone() : new THREE.Vector3(16, 26, 14)).normalize();

  // Gate the caustic render pass — reflection+refraction restored in 6.2 via TSL nodes;
  // caustics render pass remains gated here until checkpoint 6.3.
  // perf (2026-07-08 Wave 0): CAUSTICS_ENABLED is now a mutable override behind
  // setCausticsEnabled() instead of a compile-time constant, so a later wave (or the live
  // Perf A/B panel) can flip it without touching this file again. Still defaults to `true` —
  // no behavior change in this task.
  let CAUSTICS_ENABLED = true;
  let causticStrength = Number(o.caustic) || 0;
  const causticRenderStats = { enabled: CAUSTICS_ENABLED && causticStrength > 0, passes: 0, lastMs: 0 };
  // perf: every-Nth-frame caustic throttle, same seam as reflectEvery (setReflectRate).
  // Defaults to 1 (render every frame the caustic pass would otherwise run) — no default
  // behavior change in this task. setCausticRate() lets a later wave/perfAB slider throttle it.
  let causticEvery = Math.max(1, Math.round(Number(o.causticRate) || 1));
  let causticFrameCounter = -1;
  let causticLastFrameId = null;

  // ---- TSL uniform handles for the surface node material ----
  const tsl_uTime       = uniform(0.0,                  'float');
  const tsl_uWave       = uniform(o.waveStrength,        'float');
  const tsl_uShallow    = uniform(new THREE.Color(o.shallow));
  const tsl_uDeep       = uniform(new THREE.Color(o.deep));
  const tsl_uLightDir   = uniform(lightDir.clone());          // vec3
  const tsl_uDepthScale        = uniform(o.depthScale,         'float');
  const tsl_uRefractStrength   = uniform(o.refractStrength,    'float');
  const tsl_uReflectStrength   = uniform(o.reflectStrength,    'float');
  const tsl_uReflectMix        = uniform(o.reflectMix,         'float');
  const tsl_uReflectBrightness = uniform(o.reflectBrightness,  'float');

  // Per-vertex attribute: water depth at this vertex (= waterLevel - terrainHeight, ≥ 0)
  const aDepth = attribute('aDepth', 'float');

  // ---- Wave / ripple normal (TSL port of WAVE_GLSL) ----
  // waveH(p: vec2) → float — sum of 3 sine waves driven by uTime.
  // GLSL: sin(p.x*0.8 + uTime*1.3)*0.05 + sin(p.y*0.7 - uTime*1.1)*0.05 + ...
  const waveH = Fn(([p]) =>
    sin(p.x.mul(0.8).add(tsl_uTime.mul(1.3))).mul(0.05)
      .add(sin(p.y.mul(0.7).sub(tsl_uTime.mul(1.1))).mul(0.05))
      .add(sin(p.x.add(p.y).mul(1.3).add(tsl_uTime.mul(1.7))).mul(0.03))
  );

  // rippleNormal(p: vec2) → vec3 — finite-difference gradient → surface normal.
  // GLSL: hx = waveH(p+e.x)-waveH(p-e.x); normalize(vec3(-hx*uWave, 2*e, -hz*uWave))
  const ripE = 0.15;
  const rippleNormal = Fn(([p]) => {
    const hx = waveH(p.add(vec2(ripE, 0.0))).sub(waveH(p.sub(vec2(ripE, 0.0))));
    const hz = waveH(p.add(vec2(0.0, ripE))).sub(waveH(p.sub(vec2(0.0, ripE))));
    return normalize(vec3(
      hx.mul(-1.0).mul(tsl_uWave),
      float(2.0 * ripE),
      hz.mul(-1.0).mul(tsl_uWave),
    ));
  });

  // ---- Surface fragment color (TSL port of SURFACE_FRAG) ----
  // positionWorld = vWorld (interpolated world pos); aDepth = vDepth (auto-varying).
  // cameraPosition = uCamPos (built-in TSL uniform).

  // Ripple surface normal at this fragment's world XZ position.
  const N = rippleNormal(positionWorld.xz);

  // View direction from fragment toward camera.
  // GLSL: vec3 viewDir = normalize(uCamPos - vWorld)
  const viewDir = normalize(cameraPosition.sub(positionWorld));

  // Fresnel factor: 0.02 + 0.98*(1 - dot(N,viewDir))^3
  // More reflective at grazing angles, more refractive when looking straight down.
  const NdotV = clamp(dot(N, viewDir), float(0.0), float(1.0));
  const fres  = float(0.02).add(float(0.98).mul(pow(float(1.0).sub(NdotV), float(3.0))));

  // Depth factor: 0 = surface/shallow, 1 = fully deep.
  const dt = clamp(aDepth.div(tsl_uDepthScale), float(0.0), float(1.0));

  // ── Refraction (checkpoint 6.2) ────────────────────────────────────────────
  // viewportSharedTexture copies the live framebuffer via copyFramebufferToTexture()
  // during NodeUpdateType.RENDER updateBefore(), so it captures the terrain/sky that
  // has already been drawn (water renderOrder=1 → draws last among opaques).
  // No separate render pass needed; no manual RenderTarget management.
  // issues/001 safe: the copy happens during the live loop, not at construction.
  //
  // GLSL equivalent:
  //   vec2 uv = gl_FragCoord.xy / uResolution;
  //   vec3 bed = texture2D(uRefract, uv + N.xz * uRefractStrength * dt).rgb;
  const refractOffset = N.xz.mul(tsl_uRefractStrength).mul(dt);
  const bed      = viewportSharedTexture(screenUV.add(refractOffset)).rgb;
  const waterCol = mix(tsl_uShallow, tsl_uDeep, dt);
  const refr     = mix(bed, waterCol, mix(float(0.2), float(0.85), dt));

  // ── Reflection (checkpoint 6.2) ────────────────────────────────────────────
  // ReflectorNode manages its own mirror camera + RenderTarget + oblique-clip near
  // plane (the same Lengyel technique as the old updateReflection()). It renders via
  // renderer.render(scene, virtualCamera) inside its updateBefore() hook, then sets
  //   this.textureNode.value = renderTarget.texture
  // during the live loop — safely avoiding the issues/001 pre-first-render bind trap.
  // material.visible is toggled false/true around the reflection render so the water
  // surface is absent from its own reflection.
  //
  // The reflector uses the target Object3D's local +Z as the plane normal; rotating
  // by -PI/2 around X maps local +Z → world +Y (horizontal water plane).
  //
  // GLSL equivalent:
  //   vec4 rc = vReflect; rc.xy += N.xz * uReflectStrength * rc.w;
  //   vec3 refl = texture2DProj(uReflect, rc).rgb;
  // perf: half-res reflection render target (see render-bottleneck-fixes.md Problem 1).
  // resolutionScale is read live by ReflectorBaseNode._updateResolution() on every render
  // (three.webgpu.js:37162-37170, called from updateBefore at 37268), so it is safe to
  // change at runtime via reflectorBase.resolutionScale = x, not just at construction time.
  const tsl_reflector = reflector({ resolutionScale: o.reflectResolutionScale });
  const reflectorBase = tsl_reflector.reflector;
  // perf (2026-07-08 Wave 0): reflectionEnabled is the mix/brightness-derived gate ANDed with
  // an explicit manual override (setReflectionEnabled, default true = no override) so a later
  // wave/the Perf A/B panel can force reflection off without touching the mix/brightness
  // sliders. Defaults preserve existing behavior exactly.
  let reflectionManualEnabled = true;
  const computeReflectionEnabled = () => reflectionManualEnabled
    && (Number(o.reflectMix) || 0) > 0 && (Number(o.reflectBrightness) || 0) > 0;
  let reflectionEnabled = computeReflectionEnabled();
  const reflectionRenderStats = { enabled: reflectionEnabled, passes: 0, skipped: 0, excluded: 0, lastMs: 0 };
  const renderReflection = reflectorBase.updateBefore.bind(reflectorBase);
  // perf: frame-skip throttle. `reflectEvery` (set via setReflectRate(), declared below with
  // the rest of the per-frame-update state) controls how often the reflection actually
  // re-renders; on skipped frames we return early WITHOUT touching textureNode.value, so the
  // previous render target's texture stays bound (verified safe: three.webgpu.js:37356 only
  // assigns textureNode.value when a render actually runs).
  //
  // ReflectorBaseNode.updateBeforeType is NodeUpdateType.FRAME (three.webgpu.js:37118, since
  // bounces is false here), so the node system already dedupes repeat calls that share the
  // same frame.frameId (three.webgpu.js:53044-53060) — but frame.frameId itself is bumped by
  // *every* renderer._renderScene() call (three.webgpu.js:58670), including this reflector's
  // own nested render, so it is not a stable "one tick per app frame" counter on its own. We
  // track distinct frameId *transitions* to build our own frame counter: this wrapper only
  // executes once per outer renderer.render(scene, camera) call in practice (the water mesh is
  // only traversed as part of the single base-scene submission), so counting on frameId change
  // is equivalent to counting real frames while additionally guarding against any accidental
  // re-entry with an unchanged frameId.
  let reflectFrameCounter = -1;
  let reflectLastFrameId = null;
  const reflectExcludeSeen = new Set();
  const reflectExcludeScratch = [];
  function collectReflectExcludes(src, out) {
    if (!src) return;
    if (typeof src === 'function') {
      collectReflectExcludes(src(), out);
      return;
    }
    if (Array.isArray(src) || (typeof src[Symbol.iterator] === 'function' && !src.isObject3D)) {
      for (const item of src) collectReflectExcludes(item, out);
      return;
    }
    if (src.isObject3D && !reflectExcludeSeen.has(src)) {
      reflectExcludeSeen.add(src);
      out.push(src);
    }
  }
  function renderReflectionPruned(frame) {
    reflectExcludeSeen.clear();
    reflectExcludeScratch.length = 0;
    collectReflectExcludes(o.reflectExclude, reflectExcludeScratch);
    const hidden = [];
    for (const obj of reflectExcludeScratch) {
      if (!obj || obj.visible === false) continue;
      hidden.push(obj);
      obj.visible = false;
    }
    try {
      renderReflection(frame);
    } finally {
      for (const obj of hidden) obj.visible = true;
      reflectionRenderStats.excluded = hidden.length;
    }
  }
  reflectorBase.updateBefore = (frame) => {
    reflectionRenderStats.enabled = reflectionEnabled;
    if (!reflectionEnabled) {
      reflectionRenderStats.lastMs = 0;
      return;
    }
    const fid = frame && frame.frameId;
    if (fid === undefined || fid !== reflectLastFrameId) {
      reflectLastFrameId = fid;
      reflectFrameCounter++;
    }
    // Always renders on the very first frame (0 % N === 0 for any N >= 1) so the reflector
    // texture is never left blank at startup.
    if (reflectFrameCounter % reflectEvery !== 0) {
      reflectionRenderStats.skipped++;
      return;
    }
    const t0 = nowMs();
    renderReflectionPruned(frame);
    reflectionRenderStats.passes++;
    reflectionRenderStats.lastMs = nowMs() - t0;
  };
  tsl_reflector.target.rotation.x = -Math.PI / 2;
  tsl_reflector.uvNode = tsl_reflector.uvNode.add(N.xz.mul(tsl_uReflectStrength));
  const refl = tsl_reflector.rgb.mul(tsl_uReflectBrightness);

  // Fresnel blend: grazing angles → more reflection; head-on → more refraction.
  const reflectAmount = clamp(fres.mul(tsl_uReflectMix), float(0.0), float(1.0));
  const blended = mix(refr, refl, reflectAmount);

  // Specular highlight: reflect(-uLightDir, N) · viewDir.
  // reflect(I,N) = I - 2*dot(N,I)*N with I = -lightDir:
  //   = -lightDir - 2*dot(N,-lightDir)*N = -lightDir + 2*dot(N,lightDir)*N
  // GLSL: spec = pow(max(dot(reflect(-uLightDir, N), viewDir), 0.0), 80.0)
  const NdotL    = dot(N, tsl_uLightDir);
  const specRefl = tsl_uLightDir.mul(-1.0).add(N.mul(NdotL.mul(2.0)));
  const spec     = pow(max(dot(specRefl, viewDir), float(0.0)), float(80.0));

  // spec is a float scalar; adding to vec3 broadcasts to all channels (white highlight).
  const colorNode = blended.add(spec);

  // Alpha: deeper = more opaque; smoothstep edge fade at very shallow margins.
  // GLSL: alpha = clamp(0.5 + vDepth, 0.6, 0.98) * smoothstep(0.0, 0.1, vDepth)
  const opacityNode = clamp(float(0.5).add(aDepth), float(0.6), float(0.98))
                      .mul(smoothstep(float(0.0), float(0.1), aDepth));

  // ---- Assemble TSL surface material (checkpoint 6.2: real reflection + refraction) ----
  // Ported from THREE.ShaderMaterial (SURFACE_VERT / SURFACE_FRAG) to MeshBasicNodeMaterial.
  // Reflection: tsl_reflector (ReflectorNode). Refraction: viewportSharedTexture.
  const surfaceMat = new MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
  surfaceMat.colorNode   = colorNode;
  surfaceMat.opacityNode = opacityNode;
  const surface = new THREE.Group();
  surface.name = 'WaterChunks';
  surface.position.y = o.waterLevel;
  surface.renderOrder = 1;
  // Add the reflector's reference object so it inherits the water-level world position.
  // The -PI/2 X rotation (set above) makes local +Z → world +Y (horizontal mirror plane).
  surface.add(tsl_reflector.target);

  // ---- Caustic node material (TSL port of CAUSTIC_VERT / CAUSTIC_FRAG) ----
  // Per-vertex: compute vNew (refracted bed intersection) and vOld (flat baseline).
  // positionNode overrides local-space vertex position so the caustic camera
  // projects vNew.xz → clip XY (top-down caustic map). colorNode uses screen-space
  // derivatives of the varyings to compute the caustic intensity ratio.
  const tsl_cBedRef  = uniform(o.waterLevel - o.causticBedDepth, 'float');
  const tsl_cEta     = float(ETA);
  // flat-surface refracted ray (updated by setLightDir)
  const refractedFlat = refractVec(lightDir.clone().negate(), new THREE.Vector3(0, 1, 0), ETA, new THREE.Vector3());
  const tsl_baseRayU  = uniform(refractedFlat.clone());

  // P = original world position of the geometry vertex (before positionNode override).
  // causticGroup sits at y=waterLevel, so modelWorldMatrix is a pure Y-translate.
  const causticP     = modelWorldMatrix.mul(vec4(positionGeometry, float(1.0))).xyz;
  const causticN     = rippleNormal(causticP.xz);              // wave-perturbed normal
  const causticI     = tsl_uLightDir.negate();                 // incident direction (toward surface)
  const causticRay   = refract(causticI, causticN, tsl_cEta);  // TSL refract: same GLSL semantics
  // Guard against near-zero ray.y (shouldn't occur for typical light angles)
  const causticRayY  = min(causticRay.y,  float(-1e-4));
  const causticBaseY = min(tsl_baseRayU.y, float(-1e-4));
  // t = (bedRef - P.y) / ray.y  →  intersection depth along ray to the bed plane
  const causticTNew  = tsl_cBedRef.sub(causticP.y).div(causticRayY);
  const causticTOld  = tsl_cBedRef.sub(causticP.y).div(causticBaseY);
  const causticVNew  = causticP.add(causticRay.mul(causticTNew));    // perturbed bed position
  const causticVOld  = causticP.add(tsl_baseRayU.mul(causticTOld)); // flat-surface baseline

  // Interpolate vertex-stage values to fragment stage for derivative computation
  const causticVNewVar = varying(causticVNew);
  const causticVOldVar = varying(causticVOld);

  // positionNode: local-space position mapping to world position vNew.
  // causticGroup.position.y = waterLevel, so local.y = vNew.y - waterLevel
  //   = bedRef - waterLevel = -causticBedDepth
  const causticPosNode = vec3(causticVNew.x, float(-o.causticBedDepth), causticVNew.z);

  // Fragment: caustic intensity = ratio of unperturbed to perturbed bed areas
  const causticOldArea   = length(dFdx(causticVOldVar)).mul(length(dFdy(causticVOldVar)));
  const causticNewArea   = length(dFdx(causticVNewVar)).mul(length(dFdy(causticVNewVar)));
  const causticIntensity = causticOldArea.div(max(causticNewArea, float(1e-5))).mul(float(0.2));

  const causticMat = new MeshBasicNodeMaterial({ side: THREE.DoubleSide, depthTest: false, depthWrite: false });
  causticMat.positionNode = causticPosNode;
  causticMat.colorNode    = vec4(causticIntensity, float(1.0), float(0.0), float(1.0));
  const causticGroup = new THREE.Group();
  causticGroup.name = 'WaterCausticChunks';
  causticGroup.position.y = o.waterLevel;
  const causticScene = new THREE.Scene();
  causticScene.add(causticGroup);
  const lodConfig = {
    r0: o.lodR0 ?? 50,
    r1: o.lodR1 ?? 150,
    cells: [o.cellS0 ?? 1, o.cellS1 ?? 4, o.cellS2 ?? 16],
  };
  lodConfig.snaps = lodConfig.cells.map(c => c * 4);

  const waterRings = [null, null, null];
  const ringDirty = [true, true, true];
  const pendingSnaps = [null, null, null];
  const ringJobs = [null, null, null];
  const heightCaches = lodConfig.cells.map(() => makeHeightCache());
  const deferredDisposals = [];
  const stats = {
    chunks: 0, candidates: 3, pending: 3, dry: 0, minBed: Infinity, waterLevel: o.waterLevel,
    ring0Tris: 0, ring1Tris: 0, ring2Tris: 0,
    ring0Verts: 0, ring1Verts: 0, ring2Verts: 0,
    cacheHits: 0, cacheMisses: 0, lastBuildMs: 0, disposalsPending: 0,
  };
  let lastCamX = camera?.position?.x ?? 0;
  let lastCamZ = camera?.position?.z ?? 0;
  let terrainCacheSignature = `${o.size}:${o.extentX ?? ''}:${o.extentZ ?? ''}`;

  // ---------- render targets ----------
  // reflectionTarget  → replaced by tsl_reflector (ReflectorNode manages its own RT).
  // refractionTarget  → replaced by viewportSharedTexture (framebuffer copy, no RT needed).
  // causticsTarget    → retained; used by the caustics pass in checkpoint 6.3.
  const rtOpts = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
  const causticsTarget = new THREE.WebGLRenderTarget(o.causticRes, o.causticRes, rtOpts);

  // Custom orthographic camera for the caustic pass.
  // Projection: maps world XZ to clip XY, matching the original GLSL formula:
  //   gl_Position = vec4((vNew.xz - worldCenter) / (0.5 * worldSize), 0.0, 1.0)
  // View matrix row 1 swaps world-Z into view-Y so the ortho scale maps it to clip-Y.
  // Projection scales view XY to clip XY ([-sz/2, sz/2] → [-1, 1]).
  const causticCamera = new THREE.Camera();
  causticCamera.matrixAutoUpdate      = false;
  causticCamera.matrixWorldAutoUpdate = false;
  // WebGPURenderer._renderScene() calls camera.updateProjectionMatrix(); the base
  // THREE.Camera has no such method (only Perspective/Orthographic do) — it crashes.
  // This camera builds its projection manually, so make it a no-op to preserve it.
  causticCamera.updateProjectionMatrix = () => {};

  function updateCausticCamera(cx, cz, sz) {
    const s = 2 / sz;
    causticCamera.matrixWorldInverse.set(
      1,  0, 0, -cx,
      0,  0, 1, -cz,
      0, -1, 0,   0,
      0,  0, 0,   1,
    );
    causticCamera.matrixWorld.copy(causticCamera.matrixWorldInverse).invert();
    causticCamera.projectionMatrix.set(
      s, 0, 0, 0,
      0, s, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    );
    causticCamera.projectionMatrixInverse.copy(causticCamera.projectionMatrix).invert();
  }
  updateCausticCamera(0, 0, o.size);

  // ---------- terrain caustic contribution (TSL, replaces onBeforeCompile) ----------
  // TSL uniforms for the ground reverse-projection (all updated by public API / syncWaterChunks).
  const tsl_c_bedRefG       = uniform(o.waterLevel - o.causticBedDepth, 'float');
  const tsl_c_waterLevelG   = uniform(o.waterLevel, 'float');
  const tsl_c_worldSizeG    = uniform(o.size, 'float');
  const tsl_c_worldCenterG  = uniform(new THREE.Vector2(0, 0));
  const tsl_c_causticStr    = uniform(o.caustic, 'float');
  const tsl_c_refractedFlat = uniform(refractedFlat.clone());

  // CausticTextureNode extends TextureNode so updateBefore() safely binds the RT
  // texture during the live render loop — mirrors ReflectorNode's updateBefore
  // pattern (issues/001 safe: texture is set AFTER the material has first rendered).
  class CausticTextureNode extends TextureNode {
    constructor(uvNode) {
      super(causticsTarget.texture, uvNode);
      this.updateBeforeType = NodeUpdateType.RENDER;
    }
    updateBefore(frame) {
      causticRenderStats.enabled = CAUSTICS_ENABLED && causticStrength > 0 && causticGroup.children.length > 0;
      if (!causticRenderStats.enabled) {
        causticRenderStats.lastMs = 0;
        this.value = causticsTarget.texture;
        return;
      }
      // perf: every-Nth-frame throttle (setCausticRate()), same frameId-transition-counting
      // technique as the reflector's updateBefore wrapper (water.js:~630). On a skipped frame
      // we return WITHOUT touching this.value, so the previous render target's texture stays
      // bound — never a blank/black caustic texture. Default causticEvery=1 means every
      // eligible frame renders, identical to pre-throttle behavior.
      const fid = frame && frame.frameId;
      if (fid === undefined || fid !== causticLastFrameId) {
        causticLastFrameId = fid;
        causticFrameCounter++;
      }
      if (causticFrameCounter % causticEvery !== 0) {
        causticRenderStats.skipped = (causticRenderStats.skipped || 0) + 1;
        return;
      }
      const t0 = nowMs();
      const r = frame.renderer;
      const prev = r.getRenderTarget();
      r.setRenderTarget(causticsTarget);
      r.render(causticScene, causticCamera);
      r.setRenderTarget(prev);
      causticRenderStats.passes++;
      causticRenderStats.lastMs = nowMs() - t0;
      this.value = causticsTarget.texture;
    }
  }

  // Reverse-project each terrain fragment's world position along the refracted flat ray
  // to the bed reference plane, then map XZ to caustic texture UV [0,1].
  const cTT = tsl_c_bedRefG.sub(positionWorld.y).div(tsl_c_refractedFlat.y);
  const cQX = positionWorld.x.add(tsl_c_refractedFlat.x.mul(cTT));
  const cQZ = positionWorld.z.add(tsl_c_refractedFlat.z.mul(cTT));
  const cU  = cQX.sub(tsl_c_worldCenterG.x).div(tsl_c_worldSizeG).add(float(0.5));
  const cV  = cQZ.sub(tsl_c_worldCenterG.y).div(tsl_c_worldSizeG).add(float(0.5));

  // In-bounds mask: only apply caustic where projection falls inside [0,1]²
  const cInBounds = step(float(0.0), cU).mul(step(cU, float(1.0)))
                   .mul(step(float(0.0), cV)).mul(step(cV, float(1.0)));

  // CausticTextureNode instance: renders caustic scene in updateBefore(), then samples it.
  const causticTexNode = new CausticTextureNode(vec2(cU, cV));

  // Fade: 0 at/above waterLevel, 1 deeper down (same formula as original GLSL).
  const cFade = clamp(tsl_c_waterLevelG.sub(positionWorld.y).mul(float(0.6)), float(0.0), float(1.0));
  // Caustic emissive: blue-tinted additive light from focused rays.
  const cEmit = causticTexNode.r.mul(cFade).mul(tsl_c_causticStr).mul(cInBounds)
                               .mul(vec3(0.6, 0.85, 1.0));

  // Attach caustic emissive node to the terrain material.
  // Safety: terrain STAYS VISIBLE regardless because:
  //   (a) emissiveNode is purely additive — base colour is unaffected,
  //   (b) CausticTextureNode.updateBefore() sets this.value during the live loop,
  //       so the texture is always bound before the terrain draw call (issues/001 safe).
  if (ground && ground.material && ground.material.isNodeMaterial) {
    // Additive: preserve any existing emissive term (e.g. SP4a clustered point lighting on
    // the terrain) instead of clobbering it — both are additive over the base shading.
    const prior = ground.material.emissiveNode;
    ground.material.emissiveNode = prior ? prior.add(cEmit) : cEmit;
    ground.material.needsUpdate  = true;
  }

  // Note: the manual planar-reflection camera (THREE.Reflector algorithm) and its
  // helper vectors/matrices are superseded by tsl_reflector (ReflectorNode) which
  // handles mirror-camera, oblique-clip, and RT management internally.

  function clearHeightCaches() {
    for (const cache of heightCaches) {
      cache.map.clear();
      cache.hits = 0;
      cache.misses = 0;
    }
  }

  function getFallbackSnap(n) {
    const step = lodConfig.snaps[n];
    return {
      snapX: Math.round(lastCamX / step) * step,
      snapZ: Math.round(lastCamZ / step) * step,
    };
  }

  function getRingSnap(n) {
    return pendingSnaps[n]
      ?? (waterRings[n] ? { snapX: waterRings[n].snapX, snapZ: waterRings[n].snapZ } : null)
      ?? getFallbackSnap(n);
  }

  function getRingDescriptor(n, snapX, snapZ) {
    const innerHalf = n === 0 ? 0 : (n === 1 ? lodConfig.r0 : lodConfig.r1);
    const innerSnap = n === 0 ? { snapX, snapZ } : getRingSnap(n - 1);
    const outerExt = o.extentX !== undefined
      ? Math.max(o.extentX, o.extentZ ?? o.extentX) * 0.5 + lodConfig.cells[2]
      : o.size * 0.5;
    const outerHalf = n === 0 ? lodConfig.r0 : (n === 1 ? lodConfig.r1 : outerExt);
    return {
      snapX, snapZ,
      innerSnapX: innerSnap.snapX,
      innerSnapZ: innerSnap.snapZ,
      innerHalf, outerHalf,
      cellSize: lodConfig.cells[n],
      extentX: o.extentX,
      extentZ: o.extentZ,
    };
  }

  function queueGeometryDispose(geometry) {
    if (!geometry) return;
    deferredDisposals.push({ geometry, frames: Math.max(1, Math.floor(o.deferredDisposeFrames ?? 4)) });
  }

  function drainDeferredDisposals(force = false) {
    for (let i = deferredDisposals.length - 1; i >= 0; i--) {
      const item = deferredDisposals[i];
      item.frames--;
      if (force || item.frames <= 0) {
        item.geometry.dispose();
        deferredDisposals.splice(i, 1);
      }
    }
    stats.disposalsPending = deferredDisposals.length;
  }

  function removeRingMeshes(ring, defer = true) {
    if (!ring) return;
    if (ring.mesh) surface.remove(ring.mesh);
    if (ring.causticMesh) causticGroup.remove(ring.causticMesh);
    if (ring.geometry) {
      if (defer) queueGeometryDispose(ring.geometry);
      else ring.geometry.dispose();
    }
  }

  function startRingJob(n, snapX, snapZ) {
    const desc = getRingDescriptor(n, snapX, snapZ);
    ringJobs[n] = createRingGeometryJob(o, desc, heightCaches[n]);
  }

  function commitRingJob(n, job) {
    const oldRing = waterRings[n];
    const geometry = job.toGeometry();
    let nextRing;
    if (!geometry.index || geometry.index.count === 0) {
      geometry.dispose();
      nextRing = { mesh: null, causticMesh: null, geometry: null, snapX: job.desc.snapX, snapZ: job.desc.snapZ };
    } else {
      const mesh = new THREE.Mesh(geometry, surfaceMat);
      mesh.name = `WaterRing${n}`;
      mesh.renderOrder = 1;
      const causticMesh = new THREE.Mesh(geometry, causticMat);
      causticMesh.name = `WaterCausticRing${n}`;
      causticMesh.frustumCulled = false;
      surface.add(mesh);
      causticGroup.add(causticMesh);
      nextRing = { mesh, causticMesh, geometry, snapX: job.desc.snapX, snapZ: job.desc.snapZ };
    }
    const snapChanged = !oldRing || oldRing.snapX !== job.desc.snapX || oldRing.snapZ !== job.desc.snapZ;
    waterRings[n] = nextRing;
    removeRingMeshes(oldRing, true);
    ringJobs[n] = null;
    ringDirty[n] = false;
    pendingSnaps[n] = null;
    stats.lastBuildMs = job.elapsedMs;
    if (n < 2 && snapChanged) {
      const outerSnap = getRingSnap(n + 1);
      markRingDirty(n + 1, outerSnap.snapX, outerSnap.snapZ);
    }
    updateCausticProjection();
  }

  function markRingDirty(n, snapX, snapZ) {
    pendingSnaps[n] = { snapX, snapZ };
    ringDirty[n] = true;
    const job = ringJobs[n];
    if (job && (job.desc.snapX !== snapX || job.desc.snapZ !== snapZ)) ringJobs[n] = null;
  }

  function markAllRingsDirty() {
    for (let n = 0; n < 3; n++) {
      const step = lodConfig.snaps[n];
      markRingDirty(n, Math.round(lastCamX / step) * step, Math.round(lastCamZ / step) * step);
    }
  }

  function checkSnaps(camX, camZ) {
    lastCamX = camX;
    lastCamZ = camZ;
    for (let n = 0; n < 3; n++) {
      const step = lodConfig.snaps[n];
      const sx = Math.round(camX / step) * step;
      const sz = Math.round(camZ / step) * step;
      const r = waterRings[n];
      if (!r || r.snapX !== sx || r.snapZ !== sz) markRingDirty(n, sx, sz);
    }
  }

  function processRingQueue() {
    const budget = Math.max(0.25, Number(o.buildBudgetMs) || 1.5);
    const deadline = nowMs() + budget;
    const maxCommits = Math.max(1, Math.floor(o.maxBuildsPerFrame));
    let commits = 0;
    for (let pass = 0; pass < 3 && nowMs() < deadline; pass++) {
      for (let n = 0; n < 3 && nowMs() < deadline; n++) {
        if (!ringDirty[n] || !pendingSnaps[n]) continue;
        if (n > 0 && (ringDirty[n - 1] || ringJobs[n - 1] || !waterRings[n - 1])) continue;
        if (!ringJobs[n]) startRingJob(n, pendingSnaps[n].snapX, pendingSnaps[n].snapZ);
        const job = ringJobs[n];
        if (!job.step(deadline)) continue;
        if (commits >= maxCommits) return;
        commitRingJob(n, job);
        commits++;
      }
    }
  }

  function updateCausticProjection() {
    if (o.extentX !== undefined) {
      const sz = Math.max(o.extentX, o.extentZ ?? o.extentX);
      updateCausticCamera(0, 0, sz);
      tsl_c_worldSizeG.value = sz;
      tsl_c_worldCenterG.value.set(0, 0);
    } else {
      updateCausticCamera(lastCamX, lastCamZ, o.size);
      tsl_c_worldSizeG.value = o.size;
      tsl_c_worldCenterG.value.set(lastCamX, lastCamZ);
    }
  }

  markAllRingsDirty();
  updateCausticProjection();

  // ---------- per-frame update ----------
  // Reflection  : tsl_reflector (ReflectorNode) fires its own renderer.render() inside
  //               updateBefore() ? triggered automatically by the node system when
  //               renderer.render(scene, camera) is called by the host loop. Throttled to
  //               every `reflectEvery`th frame by the wrapper installed above
  //               (reflectorBase.updateBefore, water.js:~560) — see setReflectRate().
  // Refraction  : viewportSharedTexture copies the framebuffer inside updateBefore()
  //               via renderer.copyFramebufferToTexture() ? no extra pass needed.
  // Caustics    : CausticTextureNode.updateBefore() renders causticScene to causticsTarget
  //               during the live render loop (issues/001 safe ? same pattern as reflector).
  let reflectEvery = Math.max(1, Math.round(Number(o.reflectRate) || 1));
  function update(time) {
    tsl_uTime.value = time;
    camera.updateMatrixWorld();
    checkSnaps(camera.position.x, camera.position.z);
    processRingQueue();
    drainDeferredDisposals(false);
  }
  function setReflectRate(everyNFrames) {
    // Perf: throttles the reflection to render only every `everyNFrames`th real frame.
    // Consumed by the reflectorBase.updateBefore wrapper (water.js:~560), which counts
    // distinct frame.frameId transitions and skips renderReflection() on off-frames,
    // leaving the previous render target's texture bound (safe — see wrapper comment).
    reflectEvery = Math.max(1, Math.round(everyNFrames));
  }

  function resize() {
    // tsl_reflector auto-resizes its RT (ReflectorBaseNode._updateResolution on each render).
    // viewportSharedTexture reads the live framebuffer — always canvas-sized.
    // causticsTarget is fixed-resolution; no resize needed.
  }

  function regenerate(opts) {
    let terrainChanged = false;
    let ringsChanged = false;
    if (opts) {
      if (opts.size !== undefined && opts.size !== o.size) { o.size = opts.size; ringsChanged = true; }
      if (opts.waterLevel !== undefined && opts.waterLevel !== o.waterLevel) { o.waterLevel = opts.waterLevel; ringsChanged = true; }
      if (opts.heightFn !== undefined && opts.heightFn !== o.heightFn) { o.heightFn = opts.heightFn; terrainChanged = true; ringsChanged = true; }
      if (opts.extentX !== undefined && opts.extentX !== o.extentX) { o.extentX = opts.extentX; terrainChanged = true; ringsChanged = true; }
      if (opts.extentZ !== undefined && opts.extentZ !== o.extentZ) { o.extentZ = opts.extentZ; terrainChanged = true; ringsChanged = true; }
      if (opts.lodR0 !== undefined && opts.lodR0 !== lodConfig.r0) { lodConfig.r0 = opts.lodR0; ringsChanged = true; }
      if (opts.lodR1 !== undefined && opts.lodR1 !== lodConfig.r1) { lodConfig.r1 = opts.lodR1; ringsChanged = true; }
    }
    const nextTerrainSignature = `${o.size}:${o.extentX ?? ''}:${o.extentZ ?? ''}`;
    if (nextTerrainSignature !== terrainCacheSignature) {
      terrainCacheSignature = nextTerrainSignature;
      terrainChanged = true;
    }
    if (terrainChanged) clearHeightCaches();
    if (ringsChanged || terrainChanged) {
      ringJobs.fill(null);
      markAllRingsDirty();
    }
    surface.position.y = o.waterLevel;
    causticGroup.position.y = o.waterLevel;
    tsl_cBedRef.value = o.waterLevel - o.causticBedDepth;
    tsl_c_bedRefG.value = o.waterLevel - o.causticBedDepth;
    tsl_c_waterLevelG.value = o.waterLevel;
    updateCausticProjection();
  }

  function setWaves(strength) {
    tsl_uWave.value = strength;   // causticMat reuses tsl_uWave via rippleNormal
  }
  function setCaustic(strength) {
    causticStrength = Math.max(0, Number(strength) || 0);
    causticRenderStats.enabled = CAUSTICS_ENABLED && causticStrength > 0 && causticGroup.children.length > 0;
    tsl_c_causticStr.value = causticStrength;
  }

  function setReflectionTuning(opts = {}) {
    if (opts.reflectStrength !== undefined) tsl_uReflectStrength.value = opts.reflectStrength;
    if (opts.refractStrength !== undefined) tsl_uRefractStrength.value = opts.refractStrength;
    if (opts.reflectMix !== undefined) o.reflectMix = Number(opts.reflectMix) || 0;
    if (opts.reflectBrightness !== undefined) o.reflectBrightness = Number(opts.reflectBrightness) || 0;
    if (opts.reflectMix !== undefined) tsl_uReflectMix.value = o.reflectMix;
    if (opts.reflectBrightness !== undefined) tsl_uReflectBrightness.value = o.reflectBrightness;
    reflectionEnabled = computeReflectionEnabled();
    reflectionRenderStats.enabled = reflectionEnabled;
    if (opts.depthScale !== undefined) tsl_uDepthScale.value = opts.depthScale;
    // perf: reflector render-target scale (1 = full res, 0.5 = half res per dimension).
    // Safe to change at runtime — ReflectorBaseNode._updateResolution() re-reads
    // resolutionScale on every render (three.webgpu.js:37162-37170, 37268).
    if (opts.reflectResolutionScale !== undefined) {
      o.reflectResolutionScale = Math.max(0.05, Number(opts.reflectResolutionScale) || 1);
      reflectorBase.resolutionScale = o.reflectResolutionScale;
    }
    // perf: every-Nth-frame reflection throttle; same seam as setReflectRate().
    if (opts.reflectRate !== undefined) setReflectRate(opts.reflectRate);
  }

  // ---- perf (2026-07-08 Wave 0): pass-through setters for the terrain-dressing/water
  // performance specs' URL flags + Perf A/B panel. Each is a thin wrapper around existing
  // internal state (mirrors setReflectRate's shape) — none of them change the DEFAULT value
  // that createWaterSystem() starts with; they only add a way to change it after construction.

  // Explicit on/off override for the reflection pass, independent of reflectMix/brightness
  // (which remain their own gate — this ANDs with them, it doesn't replace them). Default
  // `true` = no override, matching pre-existing behavior.
  function setReflectionEnabled(enabled) {
    reflectionManualEnabled = !!enabled;
    reflectionEnabled = computeReflectionEnabled();
    reflectionRenderStats.enabled = reflectionEnabled;
  }

  // Explicit on/off override for the caustic pass, independent of causticStrength (which
  // remains its own gate). Default `true` = no override.
  function setCausticsEnabled(enabled) {
    CAUSTICS_ENABLED = !!enabled;
    causticRenderStats.enabled = CAUSTICS_ENABLED && causticStrength > 0 && causticGroup.children.length > 0;
  }

  // perf: throttles the caustic render to every `everyNFrames`th eligible frame, same
  // frameId-transition-counting technique as setReflectRate(). Default 1 = every frame
  // (current behavior).
  function setCausticRate(everyNFrames) {
    causticEvery = Math.max(1, Math.round(Number(everyNFrames) || 1));
  }

  // perf: resizes the fixed-resolution caustic render target at runtime. causticsTarget is a
  // THREE.WebGLRenderTarget — .setSize() reallocates its backing texture, which is safe to call
  // between frames (the CausticTextureNode always rebinds this.value = causticsTarget.texture
  // after a real render). Default causticRes (1024, from DEFAULTS/options) is unchanged by
  // this function existing — callers must invoke it explicitly to change resolution.
  function setCausticRes(resolution) {
    const res = Math.max(32, Math.round(Number(resolution) || o.causticRes));
    if (res === causticsTarget.width && res === causticsTarget.height) return;
    causticsTarget.setSize(res, res);
    o.causticRes = res;
  }

  // perf: named quality presets are a STORED setting only in this task (Wave 0 scaffolding —
  // see water-performance-design.md design section 4, deferred). No rendering path currently
  // reads `waterQualityPreset`; it exists so ?waterQuality=low|medium|high and the Perf A/B
  // panel have somewhere to write today, ahead of the later wave that makes low/medium/high
  // actually change shader/throttle behavior.
  let waterQualityPreset = 'high';
  function setQuality(preset) {
    if (preset === 'low' || preset === 'medium' || preset === 'high') waterQualityPreset = preset;
  }

  function setLightDir(v) {
    lightDir.copy(v).normalize();
    tsl_uLightDir.value.copy(lightDir);
    refractVec(lightDir.clone().negate(), new THREE.Vector3(0, 1, 0), ETA, refractedFlat);
    tsl_baseRayU.value.copy(refractedFlat);        // caustic vertex shader
    tsl_c_refractedFlat.value.copy(refractedFlat); // caustic ground projection
  }

  function setLodDistances(r0, r1) {
    const nextR0 = Math.max(1, Number(r0) || lodConfig.r0);
    const nextR1 = Math.max(nextR0 + lodConfig.cells[1], Number(r1) || lodConfig.r1);
    if (nextR0 === lodConfig.r0 && nextR1 === lodConfig.r1) return;
    lodConfig.r0 = nextR0;
    lodConfig.r1 = nextR1;
    ringJobs.fill(null);
    markAllRingsDirty();
  }

  function dispose() {
    for (const ring of waterRings) removeRingMeshes(ring, false);
    waterRings.fill(null);
    ringJobs.fill(null);
    deferredDisposals.length = 0;
    surfaceMat.dispose(); causticMat.dispose(); causticsTarget.dispose();
  }

  function getChunkCount() { return waterRings.filter(r => r?.mesh).length; }
  function getStats() {
    const ringTris = [0, 0, 0];
    const ringVerts = [0, 0, 0];
    let minBed = Infinity;
    for (let n = 0; n < 3; n++) {
      const g = waterRings[n]?.geometry;
      if (!g) continue;
      const position = g.getAttribute?.('position');
      const index = g.getIndex?.();
      ringVerts[n] = position?.count || 0;
      ringTris[n] = index ? Math.floor(index.count / 3) : 0;
      minBed = Math.min(minBed, g.userData.minBed ?? Infinity);
    }
    const pending = ringDirty.reduce((sum, dirty, n) => sum + ((dirty || ringJobs[n]) ? 1 : 0), 0);
    const meshCount = waterRings.filter(r => r?.mesh).length;
    const cacheHits = heightCaches.reduce((sum, cache) => sum + cache.hits, 0);
    const cacheMisses = heightCaches.reduce((sum, cache) => sum + cache.misses, 0);
    return {
      ...stats,
      chunks: meshCount,
      candidates: 3,
      pending,
      dry: 0,
      waterMeshes: meshCount,
      causticMeshes: causticRenderStats.enabled ? meshCount : 0,
      waterDraws: meshCount,
      causticDraws: causticRenderStats.enabled ? meshCount : 0,
      causticEnabled: causticRenderStats.enabled,
      causticPasses: causticRenderStats.passes,
      causticLastMs: causticRenderStats.lastMs,
      reflectionEnabled: reflectionRenderStats.enabled,
      reflectionPasses: reflectionRenderStats.passes,
      reflectionSkipped: reflectionRenderStats.skipped,
      reflectionExcluded: reflectionRenderStats.excluded,
      reflectionLastMs: reflectionRenderStats.lastMs,
      reflectionResolutionScale: o.reflectResolutionScale,
      reflectionRate: reflectEvery,
      causticSkipped: causticRenderStats.skipped || 0,
      causticRate: causticEvery,
      causticRes: causticsTarget.width,
      qualityPreset: waterQualityPreset,
      ring0Tris: ringTris[0], ring1Tris: ringTris[1], ring2Tris: ringTris[2],
      ring0Verts: ringVerts[0], ring1Verts: ringVerts[1], ring2Verts: ringVerts[2],
      waterTriangles: ringTris[0] + ringTris[1] + ringTris[2],
      causticTriangles: ringTris[0] + ringTris[1] + ringTris[2],
      waterVertices: ringVerts[0] + ringVerts[1] + ringVerts[2],
      minBed,
      waterLevel: o.waterLevel,
      cacheHits,
      cacheMisses,
      disposalsPending: deferredDisposals.length,
      version: WATER_VERSION,
    };
  }

  return {
    surface, version: WATER_VERSION, update, resize, regenerate, setWaves, setCaustic,
    setReflectionTuning, setReflectRate, setLightDir, setLodDistances, getChunkCount, getStats,
    dispose,
    // perf (2026-07-08 Wave 0): pass-through setters, see the block above setLightDir.
    setReflectionEnabled, setCausticsEnabled, setCausticRate, setCausticRes, setQuality,
  };
}

export default createWaterSystem;
