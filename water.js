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

export const WATER_VERSION = 'cw4';

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
  depthScale: 3.0,
  waveStrength: 1.0,
  caustic: 1.0,
  causticBedDepth: 3.0,     // reference bed plane sits this far below the water level
  causticRes: 1024,
  buildBudgetMs: 1.5,
  maxBuildsPerFrame: 1,
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

  const surfaceMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: SURFACE_VERT, fragmentShader: SURFACE_FRAG,
    uniforms: {
      uTime: { value: 0 }, uWave: { value: o.waveStrength },
      uRefract: { value: null }, uReflect: { value: null },
      uTextureMatrix: { value: new THREE.Matrix4() },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uShallow: { value: new THREE.Color(o.shallow) },
      uDeep: { value: new THREE.Color(o.deep) },
      uCamPos: { value: new THREE.Vector3() },
      uLightDir: { value: lightDir },
      uRefractStrength: { value: o.refractStrength },
      uReflectStrength: { value: o.reflectStrength },
      uDepthScale: { value: o.depthScale },
    },
  });
  const surface = new THREE.Group();
  surface.name = 'WaterChunks';
  surface.position.y = o.waterLevel;
  surface.renderOrder = 1;

  // caustics mesh lives in its own scene; it is rendered straight to clip space
  const causticMat = new THREE.ShaderMaterial({
    vertexShader: CAUSTIC_VERT, fragmentShader: CAUSTIC_FRAG,
    side: THREE.DoubleSide, depthTest: false, depthWrite: false,
    uniforms: {
      uTime: { value: 0 }, uWave: { value: o.waveStrength },
      uLightDir: { value: lightDir }, uEta: { value: ETA },
      uBedRef: { value: o.waterLevel - o.causticBedDepth },
      uWorldSize: { value: o.size },
      uWorldCenter: { value: new THREE.Vector2(0, 0) },
    },
  });
  causticMat.extensions = { derivatives: true };
  const causticGroup = new THREE.Group();
  causticGroup.name = 'WaterCausticChunks';
  causticGroup.position.y = o.waterLevel;
  const causticScene = new THREE.Scene();
  causticScene.add(causticGroup);
  const waterChunks = new Map();
  const stats = { chunks: 0, candidates: 0, pending: 0, dry: 0, minBed: Infinity, waterLevel: o.waterLevel };
  let waterBuildQueue = [];
  let waterBuildQueueIndex = 0;
  let waterBuildKeys = new Set();

  // ---------- render targets ----------
  const _res = new THREE.Vector2();
  renderer.getDrawingBufferSize(_res);
  const rtOpts = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
  const reflectionTarget = new THREE.WebGLRenderTarget(_res.x, _res.y, rtOpts);
  const refractionTarget = new THREE.WebGLRenderTarget(_res.x, _res.y, rtOpts);
  const causticsTarget = new THREE.WebGLRenderTarget(o.causticRes, o.causticRes, rtOpts);

  // ---------- patch the terrain material to receive caustics ----------
  // flat refracted light, reused by the ground reverse-projection
  const refractedFlat = refractVec(lightDir.clone().negate(), new THREE.Vector3(0, 1, 0), ETA, new THREE.Vector3());
  const groundUniforms = {
    uCausticTex: { value: causticsTarget.texture },
    uRefractedLightG: { value: refractedFlat },
    uBedRefG: { value: o.waterLevel - o.causticBedDepth },
    uWorldSizeG: { value: o.size },
    uWorldCenterG: { value: new THREE.Vector2(0, 0) },
    uWaterLevelG: { value: o.waterLevel },
    uCausticStrength: { value: o.caustic },
  };
  if (ground && ground.material) {
    const mat = ground.material;
    // Compose with any existing patch (e.g. the instanced terrain's heightmap
    // displacement) instead of replacing it, so displacement survives.
    const prevOnBeforeCompile = mat.onBeforeCompile;
    const prevCacheKey = mat.customProgramCacheKey;
    mat.onBeforeCompile = (shader) => {
      if (prevOnBeforeCompile) prevOnBeforeCompile.call(mat, shader);
      Object.assign(shader.uniforms, groundUniforms);
      // Inject after <project_vertex> (NOT <begin_vertex>, which displacement
      // materials consume) and honour instancing, so caustics project from the
      // final displaced world position on instanced terrain too.
      shader.vertexShader = 'varying vec3 vCausticWorldPos;\n' + shader.vertexShader.replace(
        '#include <project_vertex>',
        `#include <project_vertex>
      #ifdef USE_INSTANCING
        vCausticWorldPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
      #else
        vCausticWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
      #endif`
      );
      shader.fragmentShader = `
        varying vec3 vCausticWorldPos;
        uniform sampler2D uCausticTex;
        uniform vec3 uRefractedLightG;
        uniform float uBedRefG;
        uniform float uWorldSizeG;
        uniform vec2 uWorldCenterG;
        uniform float uWaterLevelG;
        uniform float uCausticStrength;
      ` + shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        `
        if (vCausticWorldPos.y < uWaterLevelG) {
          float tt = (uBedRefG - vCausticWorldPos.y) / uRefractedLightG.y;
          vec2 q = vCausticWorldPos.xz + uRefractedLightG.xz * tt;
          vec2 cuv = (q - uWorldCenterG) / uWorldSizeG + 0.5;
          if (cuv.x > 0.0 && cuv.x < 1.0 && cuv.y > 0.0 && cuv.y < 1.0) {
            float c = texture2D(uCausticTex, cuv).r;
            float fade = clamp((uWaterLevelG - vCausticWorldPos.y) * 0.6, 0.0, 1.0);
            gl_FragColor.rgb += uCausticStrength * c * fade * vec3(0.6, 0.85, 1.0);
          }
        }
        #include <dithering_fragment>`
      );
    };
    // If the material already had a program cache key (the instanced terrain
    // material does), compose ours so the program recompiles WITH the caustic
    // injection even if it was already compiled before water loaded.
    if (prevCacheKey) {
      mat.customProgramCacheKey = function () { return prevCacheKey.call(this) + '|caustic'; };
    }
    mat.needsUpdate = true;
  }

  // ---------- planar-reflection camera (THREE.Reflector algorithm) ----------
  const reflectionCamera = new THREE.PerspectiveCamera();
  const textureMatrix = new THREE.Matrix4();
  const _reflectorPos = new THREE.Vector3();
  const _camPos = new THREE.Vector3();
  const _normal = new THREE.Vector3(0, 1, 0);
  const _view = new THREE.Vector3();
  const _target = new THREE.Vector3();
  const _look = new THREE.Vector3();
  const _rot = new THREE.Matrix4();
  const _clipPlane = new THREE.Plane();
  const _clipVec = new THREE.Vector4();
  const _q = new THREE.Vector4();
  const CLIP_BIAS = 0.003;

  function disposeWaterChunk(chunk) {
    surface.remove(chunk.mesh);
    causticGroup.remove(chunk.causticMesh);
    chunk.geometry.dispose();
  }

  function addWaterChunk(bounds) {
    const geometry = buildGeometry(o, bounds);
    stats.minBed = Math.min(stats.minBed, geometry.userData.minBed ?? Infinity);
    if (!geometry.index || geometry.index.count === 0) {
      geometry.dispose();
      return false;
    }
    const mesh = new THREE.Mesh(geometry, surfaceMat);
    mesh.name = `WaterChunk:${bounds.key}`;
    mesh.renderOrder = 1;
    const causticMesh = new THREE.Mesh(geometry, causticMat);
    causticMesh.name = `WaterCaustic:${bounds.key}`;
    causticMesh.frustumCulled = false;
    waterChunks.set(bounds.key, { mesh, causticMesh, geometry });
    surface.add(mesh);
    causticGroup.add(causticMesh);
    return true;
  }

  function syncWaterChunks() {
    if (waterBuildQueueIndex > 0) {
      waterBuildQueue = waterBuildQueue.slice(waterBuildQueueIndex);
      waterBuildQueueIndex = 0;
    }
    const bounds = getChunkBounds(o);
    const activeKeys = new Set();
    stats.candidates = bounds.length;
    stats.dry = 0;
    stats.minBed = Infinity;
    stats.waterLevel = o.waterLevel;
    for (const b of bounds) {
      activeKeys.add(b.key);
      if (waterChunks.has(b.key)) {
        stats.minBed = Math.min(stats.minBed, waterChunks.get(b.key).geometry.userData.minBed ?? Infinity);
        continue;
      }
      if (!waterBuildKeys.has(b.key)) {
        waterBuildQueue.push(b);
        waterBuildKeys.add(b.key);
      }
    }
    for (const [key, chunk] of waterChunks) {
      if (!activeKeys.has(key)) {
        disposeWaterChunk(chunk);
        waterChunks.delete(key);
      }
    }
    waterBuildQueue = waterBuildQueue.filter((b) => {
      if (activeKeys.has(b.key) && !waterChunks.has(b.key)) return true;
      waterBuildKeys.delete(b.key);
      return false;
    });
    const projection = getWorldProjection(bounds);
    causticMat.uniforms.uWorldSize.value = projection.size;
    causticMat.uniforms.uWorldCenter.value.set(projection.centerX, projection.centerZ);
    groundUniforms.uWorldSizeG.value = projection.size;
    groundUniforms.uWorldCenterG.value.set(projection.centerX, projection.centerZ);
    stats.chunks = waterChunks.size;
    stats.pending = Math.max(0, waterBuildQueue.length - waterBuildQueueIndex);
    stats.dry = Math.max(0, stats.candidates - stats.chunks - stats.pending);
  }

  function processWaterBuildQueue() {
    if (waterBuildQueueIndex >= waterBuildQueue.length) {
      waterBuildQueue = [];
      waterBuildQueueIndex = 0;
      return;
    }
    const start = performance.now();
    const maxBuilds = Math.max(1, Math.floor(o.maxBuildsPerFrame));
    let built = 0;
    while (waterBuildQueueIndex < waterBuildQueue.length && built < maxBuilds) {
      if (built > 0 && performance.now() - start >= o.buildBudgetMs) break;
      const bounds = waterBuildQueue[waterBuildQueueIndex++];
      waterBuildKeys.delete(bounds.key);
      if (!bounds || waterChunks.has(bounds.key)) continue;
      addWaterChunk(bounds);
      built++;
    }
    if (waterBuildQueueIndex >= waterBuildQueue.length) {
      waterBuildQueue = [];
      waterBuildQueueIndex = 0;
    }
    stats.chunks = waterChunks.size;
    stats.pending = Math.max(0, waterBuildQueue.length - waterBuildQueueIndex);
    stats.dry = Math.max(0, stats.candidates - stats.chunks - stats.pending);
  }

  function updateReflection() {
    _reflectorPos.set(0, surface.position.y, 0);
    _camPos.setFromMatrixPosition(camera.matrixWorld);

    _view.subVectors(_reflectorPos, _camPos);
    if (_view.dot(_normal) > 0) return false; // camera is below the water
    _view.reflect(_normal).negate().add(_reflectorPos);

    _rot.extractRotation(camera.matrixWorld);
    _look.set(0, 0, -1).applyMatrix4(_rot).add(_camPos);
    _target.subVectors(_reflectorPos, _look);
    _target.reflect(_normal).negate().add(_reflectorPos);

    reflectionCamera.position.copy(_view);
    reflectionCamera.up.set(0, 1, 0).applyMatrix4(_rot).reflect(_normal);
    reflectionCamera.lookAt(_target);
    reflectionCamera.far = camera.far;
    reflectionCamera.updateMatrixWorld();
    reflectionCamera.projectionMatrix.copy(camera.projectionMatrix);

    // texture matrix maps world position -> reflection texture uv (bias * P * V)
    textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    textureMatrix.multiply(reflectionCamera.projectionMatrix);
    reflectionCamera.matrixWorldInverse.copy(reflectionCamera.matrixWorld).invert();
    textureMatrix.multiply(reflectionCamera.matrixWorldInverse);

    // oblique near plane so under-water geometry is clipped out of the reflection
    _clipPlane.setFromNormalAndCoplanarPoint(_normal, _reflectorPos);
    _clipPlane.applyMatrix4(reflectionCamera.matrixWorldInverse);
    _clipVec.set(_clipPlane.normal.x, _clipPlane.normal.y, _clipPlane.normal.z, _clipPlane.constant);
    const P = reflectionCamera.projectionMatrix.elements;
    _q.x = (Math.sign(_clipVec.x) + P[8]) / P[0];
    _q.y = (Math.sign(_clipVec.y) + P[9]) / P[5];
    _q.z = -1.0;
    _q.w = (1.0 + P[10]) / P[14];
    _clipVec.multiplyScalar(2.0 / _clipVec.dot(_q));
    P[2] = _clipVec.x; P[6] = _clipVec.y; P[10] = _clipVec.z + 1.0 - CLIP_BIAS; P[14] = _clipVec.w;
    return true;
  }

  syncWaterChunks();

  // ---------- per-frame multi-pass update ----------
  let reflectEvery = 1, frame = 0;
  function update(time) {
    processWaterBuildQueue();
    surfaceMat.uniforms.uTime.value = time;
    surfaceMat.uniforms.uWave.value = causticMat.uniforms.uWave.value;
    causticMat.uniforms.uTime.value = time;
    camera.updateMatrixWorld(); // ensure reflection reads the current camera pose

    // throttle the (expensive) reflection pass; reuse the last reflection on skip
    const doReflect = (frame % reflectEvery) === 0;
    frame++;

    const prevTarget = renderer.getRenderTarget();
    surface.visible = false;

    // 1) caustics map (cheap; just the lake grid, straight to clip space)
    renderer.setRenderTarget(causticsTarget);
    renderer.render(causticScene, camera);

    // 2) planar reflection (scene without the surface, mirrored camera)
    if (doReflect && updateReflection()) {
      renderer.setRenderTarget(reflectionTarget);
      renderer.render(scene, reflectionCamera);
    }

    // 3) refraction (scene without the surface, main camera)
    renderer.setRenderTarget(refractionTarget);
    renderer.render(scene, camera);

    renderer.setRenderTarget(prevTarget);
    surface.visible = true;

    const u = surfaceMat.uniforms;
    u.uRefract.value = refractionTarget.texture;
    u.uReflect.value = reflectionTarget.texture;
    if (doReflect) u.uTextureMatrix.value.copy(textureMatrix); // keep texture & matrix in sync
    u.uCamPos.value.copy(camera.position);
    renderer.getDrawingBufferSize(_res);
    u.uResolution.value.copy(_res);
  }
  function setReflectRate(everyNFrames) { reflectEvery = Math.max(1, Math.round(everyNFrames)); }

  function resize() {
    renderer.getDrawingBufferSize(_res);
    reflectionTarget.setSize(_res.x, _res.y);
    refractionTarget.setSize(_res.x, _res.y);
  }

  function regenerate(opts) {
    let rebuildExisting = false;
    if (opts) {
      if (opts.size !== undefined) o.size = opts.size;
      if (opts.waterLevel !== undefined && opts.waterLevel !== o.waterLevel) {
        o.waterLevel = opts.waterLevel;
        rebuildExisting = true;
      }
      if (opts.heightFn !== undefined && opts.heightFn !== o.heightFn) {
        o.heightFn = opts.heightFn;
        rebuildExisting = true;
      }
      if (opts.chunks !== undefined) o.chunks = opts.chunks;
    }
    if (rebuildExisting) {
      for (const chunk of waterChunks.values()) disposeWaterChunk(chunk);
      waterChunks.clear();
      waterBuildQueue = [];
      waterBuildQueueIndex = 0;
      waterBuildKeys.clear();
    }
    syncWaterChunks();
    surface.position.y = o.waterLevel;
    causticGroup.position.y = o.waterLevel;
    causticMat.uniforms.uBedRef.value = o.waterLevel - o.causticBedDepth;
    groundUniforms.uBedRefG.value = o.waterLevel - o.causticBedDepth;
    groundUniforms.uWaterLevelG.value = o.waterLevel;
  }

  function setWaves(strength) { causticMat.uniforms.uWave.value = strength; }
  function setCaustic(strength) { groundUniforms.uCausticStrength.value = strength; }

  function setLightDir(v) {
    lightDir.copy(v).normalize();
    // both uLightDir uniforms share the same lightDir reference, so mutation suffices;
    // the ground refracted-ray uniform needs recomputing from the new direction
    refractVec(lightDir.clone().negate(), new THREE.Vector3(0, 1, 0), ETA, refractedFlat);
  }

  function dispose() {
    for (const chunk of waterChunks.values()) disposeWaterChunk(chunk);
    waterChunks.clear();
    surfaceMat.dispose(); causticMat.dispose();
    reflectionTarget.dispose(); refractionTarget.dispose(); causticsTarget.dispose();
  }

  function getChunkCount() { return waterChunks.size; }
  function getStats() { return { ...stats, chunks: waterChunks.size, pending: Math.max(0, waterBuildQueue.length - waterBuildQueueIndex), version: WATER_VERSION }; }

  return { surface, version: WATER_VERSION, update, resize, regenerate, setWaves, setCaustic, setReflectRate, setLightDir, getChunkCount, getStats, dispose };
}

export default createWaterSystem;
