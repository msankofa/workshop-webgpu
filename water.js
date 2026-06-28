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

function buildRingGeometry(o, { snapX, snapZ, innerHalf, outerHalf, cellSize, extentX, extentZ }) {
  const xMin = snapX - outerHalf;
  const zMin = snapZ - outerHalf;
  const nX = Math.max(1, Math.round((outerHalf * 2) / cellSize));
  const nZ = Math.max(1, Math.round((outerHalf * 2) / cellSize));
  const nx = nX + 1, nz = nZ + 1;
  const level = o.waterLevel;
  const heightFn = o.heightFn || (() => 0);

  const positions = new Float32Array(nx * nz * 3);
  const depths    = new Float32Array(nx * nz);
  const bed       = new Float32Array(nx * nz);
  let minBed = Infinity;

  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const idx = j * nx + i;
      const x = xMin + i * cellSize;
      const z = zMin + j * cellSize;
      const b = heightFn(x, z);
      minBed = Math.min(minBed, b);
      bed[idx] = b;
      positions[idx * 3]     = x;
      positions[idx * 3 + 1] = 0;
      positions[idx * 3 + 2] = z;
      depths[idx] = Math.max(0, level - b);
    }
  }

  const indices = [];
  for (let j = 0; j < nZ; j++) {
    for (let i = 0; i < nX; i++) {
      const cx = xMin + (i + 0.5) * cellSize;
      const cz = zMin + (j + 0.5) * cellSize;
      // annular exclusion: skip quads inside the finer ring's footprint
      if (innerHalf > 0 && Math.abs(cx - snapX) <= innerHalf && Math.abs(cz - snapZ) <= innerHalf) continue;
      // extent clip: skip quads outside authored map bounds
      if (extentX !== undefined && (cx < -extentX * 0.5 || cx > extentX * 0.5)) continue;
      if (extentZ !== undefined && (cz < -extentZ * 0.5 || cz > extentZ * 0.5)) continue;
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      // dry skip: all four corners above water
      if (bed[a] >= level && bed[b] >= level && bed[c] >= level && bed[d] >= level) continue;
      indices.push(a, c, b, b, c, d);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('aDepth',   new THREE.BufferAttribute(depths, 1));
  g.setIndex(indices);
  g.computeBoundingSphere();
  g.userData.minBed = minBed;
  return g;
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
  const CAUSTICS_ENABLED = true;

  // ---- TSL uniform handles for the surface node material ----
  const tsl_uTime       = uniform(0.0,                  'float');
  const tsl_uWave       = uniform(o.waveStrength,        'float');
  const tsl_uShallow    = uniform(new THREE.Color(o.shallow));
  const tsl_uDeep       = uniform(new THREE.Color(o.deep));
  const tsl_uLightDir   = uniform(lightDir.clone());          // vec3
  const tsl_uDepthScale      = uniform(o.depthScale,       'float');
  const tsl_uRefractStrength = uniform(o.refractStrength,  'float');
  const tsl_uReflectStrength = uniform(o.reflectStrength,  'float');

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
  const tsl_reflector = reflector();
  tsl_reflector.target.rotation.x = -Math.PI / 2;
  tsl_reflector.uvNode = tsl_reflector.uvNode.add(N.xz.mul(tsl_uReflectStrength));
  const refl = tsl_reflector.rgb;

  // Fresnel blend: grazing angles → more reflection; head-on → more refraction.
  const blended = mix(refr, refl, fres);

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
  // ---- LOD config (mutable so setLodDistances() can update live) ----
  const lodConfig = {
    r0: o.lodR0 ?? 50,
    r1: o.lodR1 ?? 150,
    cells: [o.cellS0 ?? 1, o.cellS1 ?? 4, o.cellS2 ?? 16],
  };
  lodConfig.snaps = lodConfig.cells.map(c => c * 4);

  // ---- ring state ----
  const waterRings   = [null, null, null];  // { mesh, causticMesh, geometry, snapX, snapZ }
  const ringDirty    = [true, true, true];
  const pendingSnaps = [null, null, null];  // { snapX, snapZ } queued for next processRingQueue
  let lastCamX = 0, lastCamZ = 0;

  function getRingDescriptor(n, snapX, snapZ) {
    const innerHalf = n === 0 ? 0 : (n === 1 ? lodConfig.r0 : lodConfig.r1);
    const outerExt  = o.extentX !== undefined
      ? Math.max(o.extentX, o.extentZ ?? o.extentX) * 0.5 + lodConfig.cells[2]
      : o.size * 0.5;
    const outerHalf = n === 0 ? lodConfig.r0 : (n === 1 ? lodConfig.r1 : outerExt);
    return { snapX, snapZ, innerHalf, outerHalf, cellSize: lodConfig.cells[n],
             extentX: o.extentX, extentZ: o.extentZ };
  }

  function disposeRing(n) {
    const r = waterRings[n];
    if (!r) return;
    if (r.mesh)        surface.remove(r.mesh);
    if (r.causticMesh) causticGroup.remove(r.causticMesh);
    if (r.geometry)    r.geometry.dispose();
    waterRings[n] = null;
  }

  function buildRing(n, snapX, snapZ) {
    disposeRing(n);
    const desc = getRingDescriptor(n, snapX, snapZ);
    const geometry = buildRingGeometry(o, desc);
    if (!geometry.index || geometry.index.count === 0) {
      geometry.dispose();
      waterRings[n] = { mesh: null, causticMesh: null, geometry: null, snapX, snapZ };
      return;
    }
    const mesh = new THREE.Mesh(geometry, surfaceMat);
    mesh.name = `WaterRing${n}`;
    mesh.renderOrder = 1;
    const causticMesh = new THREE.Mesh(geometry, causticMat);
    causticMesh.name = `WaterCausticRing${n}`;
    causticMesh.frustumCulled = false;
    surface.add(mesh);
    causticGroup.add(causticMesh);
    waterRings[n] = { mesh, causticMesh, geometry, snapX, snapZ };
    updateCausticProjection();
  }

  function checkSnaps(camX, camZ) {
    lastCamX = camX; lastCamZ = camZ;
    for (let n = 0; n < 3; n++) {
      const step = lodConfig.snaps[n];
      const sx   = Math.round(camX / step) * step;
      const sz   = Math.round(camZ / step) * step;
      const r    = waterRings[n];
      if (!r || r.snapX !== sx || r.snapZ !== sz) {
        pendingSnaps[n] = { snapX: sx, snapZ: sz };
        ringDirty[n]    = true;
      }
    }
  }

  function processRingQueue() {
    const start    = performance.now();
    const maxBuild = Math.max(1, Math.floor(o.maxBuildsPerFrame));
    let built = 0;
    for (let n = 0; n < 3 && built < maxBuild; n++) {
      if (!ringDirty[n] || !pendingSnaps[n]) continue;
      if (built > 0 && performance.now() - start >= o.buildBudgetMs) break;
      const { snapX, snapZ } = pendingSnaps[n];
      buildRing(n, snapX, snapZ);
      ringDirty[n]    = false;
      pendingSnaps[n] = null;
      built++;
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
  // TSL uniforms for the ground reverse-projection (all updated by public API / regenerate).
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
      const r = frame.renderer;
      const prev = r.getRenderTarget();
      r.setRenderTarget(causticsTarget);
      r.render(causticScene, causticCamera);
      r.setRenderTarget(prev);
      this.value = causticsTarget.texture; // re-set during live loop → issues/001 safe
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


  // ---------- per-frame update ----------
  // Reflection  : tsl_reflector (ReflectorNode) fires its own renderer.render() inside
  //               updateBefore() — triggered automatically by the node system when
  //               renderer.render(scene, camera) is called by the host loop.
  // Refraction  : viewportSharedTexture copies the framebuffer inside updateBefore()
  //               via renderer.copyFramebufferToTexture() — no extra pass needed.
  // Caustics    : CausticTextureNode.updateBefore() renders causticScene to causticsTarget
  //               during the live render loop (issues/001 safe — same pattern as reflector).
  let reflectEvery = 1;  // retained for API; no rate effect with ReflectorNode (renders per-frame)
  function update(time) {
    tsl_uTime.value = time;
    camera.updateMatrixWorld();
    checkSnaps(camera.position.x, camera.position.z);
    processRingQueue();
  }
  function setReflectRate(everyNFrames) {
    // API preserved. With ReflectorNode the reflector renders every frame automatically;
    // per-N-frame throttling requires ReflectorNode.updateBeforeType manipulation
    // which is deferred to a later pass.
    reflectEvery = Math.max(1, Math.round(everyNFrames));
  }

  function resize() {
    // tsl_reflector auto-resizes its RT (ReflectorBaseNode._updateResolution on each render).
    // viewportSharedTexture reads the live framebuffer — always canvas-sized.
    // causticsTarget is fixed-resolution; no resize needed.
  }

  function regenerate(opts) {
    if (opts) {
      if (opts.waterLevel !== undefined) o.waterLevel = opts.waterLevel;
      if (opts.heightFn  !== undefined) o.heightFn   = opts.heightFn;
      if (opts.extentX   !== undefined) o.extentX    = opts.extentX;
      if (opts.extentZ   !== undefined) o.extentZ    = opts.extentZ;
      if (opts.lodR0     !== undefined) lodConfig.r0 = opts.lodR0;
      if (opts.lodR1     !== undefined) lodConfig.r1 = opts.lodR1;
    }
    for (let n = 0; n < 3; n++) {
      disposeRing(n);
      ringDirty[n] = true;
      const step = lodConfig.snaps[n];
      pendingSnaps[n] = { snapX: Math.round(lastCamX / step) * step, snapZ: Math.round(lastCamZ / step) * step };
    }
    surface.position.y      = o.waterLevel;
    causticGroup.position.y = o.waterLevel;
    tsl_cBedRef.value       = o.waterLevel - o.causticBedDepth;
    tsl_c_bedRefG.value     = o.waterLevel - o.causticBedDepth;
    tsl_c_waterLevelG.value = o.waterLevel;
    updateCausticProjection();
  }

  function setWaves(strength) {
    tsl_uWave.value = strength;   // causticMat reuses tsl_uWave via rippleNormal
  }
  function setCaustic(strength) { tsl_c_causticStr.value = strength; }

  function setLightDir(v) {
    lightDir.copy(v).normalize();
    tsl_uLightDir.value.copy(lightDir);
    refractVec(lightDir.clone().negate(), new THREE.Vector3(0, 1, 0), ETA, refractedFlat);
    tsl_baseRayU.value.copy(refractedFlat);        // caustic vertex shader
    tsl_c_refractedFlat.value.copy(refractedFlat); // caustic ground projection
  }

  function dispose() {
    for (let n = 0; n < 3; n++) disposeRing(n);
    surfaceMat.dispose(); causticMat.dispose(); causticsTarget.dispose();
  }

  function getChunkCount() { return waterRings.filter(r => r?.mesh).length; }

  function getStats() {
    const ringTris  = [0, 0, 0];
    const ringVerts = [0, 0, 0];
    for (let n = 0; n < 3; n++) {
      const r = waterRings[n];
      if (!r?.geometry) continue;
      const pos = r.geometry.getAttribute?.('position');
      const idx = r.geometry.getIndex?.();
      ringVerts[n] = pos?.count ?? 0;
      ringTris[n]  = idx ? Math.floor(idx.count / 3) : 0;
    }
    const totalTris  = ringTris[0]  + ringTris[1]  + ringTris[2];
    const totalVerts = ringVerts[0] + ringVerts[1] + ringVerts[2];
    const minBed     = Math.min(...waterRings.map(r => r?.geometry?.userData?.minBed ?? Infinity));
    const meshCount  = waterRings.filter(r => r?.mesh).length;
    return {
      version: WATER_VERSION, waterLevel: o.waterLevel,
      ring0Tris:  ringTris[0],  ring1Tris:  ringTris[1],  ring2Tris:  ringTris[2],
      ring0Verts: ringVerts[0], ring1Verts: ringVerts[1], ring2Verts: ringVerts[2],
      waterTriangles: totalTris, waterVertices: totalVerts,
      waterMeshes: meshCount, causticMeshes: meshCount,
      waterDraws: meshCount, causticDraws: meshCount,
      chunks: meshCount, candidates: 3,
      pending: ringDirty.filter(Boolean).length,
      dry: 0, minBed,
    };
  }

  function setLodDistances(r0, r1) {
    lodConfig.r0 = r0;
    lodConfig.r1 = r1;
    for (let n = 0; n < 3; n++) {
      disposeRing(n);
      ringDirty[n] = true;
      const step = lodConfig.snaps[n];
      pendingSnaps[n] = { snapX: Math.round(lastCamX / step) * step, snapZ: Math.round(lastCamZ / step) * step };
    }
  }

  return { surface, version: WATER_VERSION, update, resize, regenerate, setWaves, setCaustic, setReflectRate, setLightDir, setLodDistances, getChunkCount, getStats, dispose };
}

export default createWaterSystem;
