// clustered-lights.js
// SP4a — froxel clustered forward+ point lighting (WebGPU-reachable SOTA). A per-frame
// compute pass culls many dynamic point lights into a 3D view-frustum cluster grid
// (tilesX×tilesY screen tiles × exp depth slices); lit surfaces read only their froxel's
// lights and accumulate Cook-Torrance GGX, injected as an additive emissiveNode term over
// three's untouched sun/ambient. Cull math is the Node-tested twin in light-cluster.js.
//
// v1 cull = one thread PER FROXEL, looping the lights with the exact sphere-vs-froxel-AABB
// test (mirrors assignLightsExact, no atomics — each froxel owns its index list). The
// Drobot Z-bin/bitmask cull (also Node-tested) is the documented perf refinement for later.
import * as THREE from 'three';
import { StorageBufferAttribute } from 'three/webgpu';
import {
  Fn, If, Loop, instanceIndex, storage, uniform, screenUV,
  float, int, uint, vec2, vec3, vec4, floor, max, min, clamp, pow, log, dot, normalize, length, mix, modInt,
} from 'three/tsl';

const PI = 3.14159265;

export function createClusteredLights(opts) {
  const { renderer, camera } = opts;
  const cfg = {
    tile: opts.tile ?? 32,
    zSlices: opts.zSlices ?? 24,
    near: opts.near ?? camera.near,
    far: opts.far ?? 600,
    maxPerFroxel: opts.maxPerFroxel ?? 64,
    capLights: opts.capLights ?? 512,
    count: Math.min(opts.count ?? 256, opts.capLights ?? 512),
  };
  // Allocate froxel buffers for a generous max grid (covers ~2560×1440 at tile=32); the
  // active grid clamps to this. froxelIndex = (slice*tilesY + ty)*tilesX + tx.
  const MAXTX = Math.ceil(2560 / cfg.tile), MAXTY = Math.ceil(1440 / cfg.tile);
  const FROXEL_CAP = MAXTX * MAXTY * cfg.zSlices;
  const MPF = cfg.maxPerFroxel;

  // ---- buffers (GPU-resident) ----
  // light: 2× vec4 per light → [2i]=(wx,wy,wz,radius), [2i+1]=(r,g,b,intensity)
  const lightAttr = new StorageBufferAttribute(new Float32Array(cfg.capLights * 8), 4);
  const lights = storage(lightAttr, 'vec4', cfg.capLights * 2);
  const countAttr = new StorageBufferAttribute(new Uint32Array(FROXEL_CAP), 1);
  const counts = storage(countAttr, 'uint', FROXEL_CAP);
  const idxAttr = new StorageBufferAttribute(new Uint32Array(FROXEL_CAP * MPF), 1);
  const indices = storage(idxAttr, 'uint', FROXEL_CAP * MPF);

  // ---- camera-derived uniforms ----
  const W = renderer.domElement?.width || window.innerWidth;
  const H = renderer.domElement?.height || window.innerHeight;
  const fovY = (camera.fov ?? 50) * Math.PI / 180;
  const tanHalf0 = Math.tan(fovY / 2);
  const computeTiles = (w, h) => ({ tx: Math.min(MAXTX, Math.ceil(w / cfg.tile)), ty: Math.min(MAXTY, Math.ceil(h / cfg.tile)) });
  let { tx: tilesX0, ty: tilesY0 } = computeTiles(W, H);

  const uView = uniform(new THREE.Matrix4());
  const uCamPos = uniform(new THREE.Vector3());
  const uScreen = uniform(new THREE.Vector2(W, H));
  const uTile = uniform(cfg.tile);
  const uTilesX = uniform(tilesX0);
  const uTilesY = uniform(tilesY0);
  const uZSlices = uniform(cfg.zSlices);
  const uNear = uniform(cfg.near);
  const uFar = uniform(cfg.far);
  const uInvLogRatio = uniform(1 / Math.log(cfg.far / cfg.near));   // for zSlice
  const uTanHalf = uniform(tanHalf0);
  const uAspect = uniform(W / H);
  const uCount = uniform(cfg.count);
  const uFroxelCount = uniform(tilesX0 * tilesY0 * cfg.zSlices);

  // ---- shared TSL math (transcribes light-cluster.js) ----
  const zSliceOf = Fn(([d]) => {
    const s = floor(log(d.div(uNear)).mul(uInvLogRatio).mul(uZSlices));
    return clamp(int(s), int(0), int(uZSlices).sub(int(1)));
  });
  const sliceDepth = Fn(([s]) => {   // returns vec2(dNear, dFar) for slice s (float)
    const ratio = uFar.div(uNear);
    const dN = uNear.mul(pow(ratio, s.div(uZSlices)));
    const dF = uNear.mul(pow(ratio, s.add(1).div(uZSlices)));
    return vec2(dN, dF);
  });
  const ndcX = Fn(([txf]) => min(txf.mul(uTile), uScreen.x).div(uScreen.x).mul(2).sub(1));
  const ndcY = Fn(([tyf]) => min(tyf.mul(uTile), uScreen.y).div(uScreen.y).mul(2).sub(1));

  // ---- cull: one thread per froxel; loop lights with exact sphere-vs-AABB test ----
  const cull = Fn(() => {
    const f = int(instanceIndex);
    If(f.lessThan(int(uFroxelCount)), () => {
      const tX = int(uTilesX), tY = int(uTilesY);
      const tx = modInt(f, tX);
      const fy = f.sub(tx).div(tX);          // = ty + s*tilesY (exact-multiple int div)
      const ty = modInt(fy, tY);
      const s = fy.sub(ty).div(tY);
      // froxel view-space AABB from NDC corners at the slice depth range
      const nx0 = ndcX(tx.toFloat()), nx1 = ndcX(tx.toFloat().add(1));
      const ny0 = ndcY(ty.toFloat()), ny1 = ndcY(ty.toFloat().add(1));
      const dr = sliceDepth(s.toFloat());
      const kx = uTanHalf.mul(uAspect), ky = uTanHalf;
      // x extent is widest at dFar; signs handled by min/max over the corner products
      const xs = [nx0.mul(dr.x).mul(kx), nx1.mul(dr.x).mul(kx), nx0.mul(dr.y).mul(kx), nx1.mul(dr.y).mul(kx)];
      const ys = [ny0.mul(dr.x).mul(ky), ny1.mul(dr.x).mul(ky), ny0.mul(dr.y).mul(ky), ny1.mul(dr.y).mul(ky)];
      const minX = min(min(xs[0], xs[1]), min(xs[2], xs[3])), maxX = max(max(xs[0], xs[1]), max(xs[2], xs[3]));
      const minY = min(min(ys[0], ys[1]), min(ys[2], ys[3])), maxY = max(max(ys[0], ys[1]), max(ys[2], ys[3]));
      const minZ = dr.y.negate(), maxZ = dr.x.negate();   // z = -depth; far is more negative

      const cnt = int(0).toVar();
      Loop(int(uCount), ({ i }) => {
        const rec = lights.element(int(i).mul(2));
        const wp = rec.xyz, r = rec.w;
        const vp = uView.mul(vec4(wp, 1.0)).xyz;
        // sphere vs AABB: squared distance to clamped point
        const dx = max(max(minX.sub(vp.x), vp.x.sub(maxX)), 0.0);
        const dy = max(max(minY.sub(vp.y), vp.y.sub(maxY)), 0.0);
        const dz = max(max(minZ.sub(vp.z), vp.z.sub(maxZ)), 0.0);
        const d2 = dx.mul(dx).add(dy.mul(dy)).add(dz.mul(dz));
        If(d2.lessThanEqual(r.mul(r)).and(cnt.lessThan(int(MPF))), () => {
          indices.element(f.mul(int(MPF)).add(cnt)).assign(uint(i));
          cnt.assign(cnt.add(1));
        });
      });
      counts.element(f).assign(uint(cnt));
    });
  })().compute(FROXEL_CAP);

  // ---- GGX shading term, additive over three's sun/ambient (inject into emissiveNode) ----
  // posWorld/nWorld from the host material; albedo/rough/metal describe the surface response.
  const pointLightTerm = (posWorld, nWorld, albedo = vec3(0.18), rough = float(0.7), metal = float(0.0)) => Fn(() => {
    const vp = uView.mul(vec4(posWorld, 1.0)).xyz;
    const d = vp.z.negate();
    const out = vec3(0).toVar();
    If(d.greaterThan(uNear), () => {
      const slice = zSliceOf(d);
      const tx = clamp(int(floor(screenUV.x.mul(uScreen.x).div(uTile))), int(0), int(uTilesX).sub(int(1)));
      const ty = clamp(int(floor(screenUV.y.oneMinus().mul(uScreen.y).div(uTile))), int(0), int(uTilesY).sub(int(1)));
      const f = slice.mul(int(uTilesY)).add(ty).mul(int(uTilesX)).add(tx);
      const cnt = int(counts.element(f));
      const N = normalize(nWorld);
      const V = normalize(uCamPos.sub(posWorld));
      const NdotV = max(dot(N, V), 1e-4);
      const F0 = mix(vec3(0.04), albedo, metal);
      const a = rough.mul(rough);
      Loop(cnt, ({ i }) => {
        const li = int(indices.element(f.mul(int(MPF)).add(int(i))));
        const lp = lights.element(li.mul(2)).xyz, lr = lights.element(li.mul(2)).w;
        const lcol = lights.element(li.mul(2).add(1)).xyz, lint = lights.element(li.mul(2).add(1)).w;
        const Lv = lp.sub(posWorld);
        const dist = length(Lv);
        const L = Lv.div(max(dist, 1e-3));
        const NdotL = max(dot(N, L), 0.0);
        // smooth inverse-square falloff windowed to radius
        const win = clamp(float(1).sub(pow(dist.div(lr), 4.0)), 0.0, 1.0);
        const atten = win.mul(win).div(dist.mul(dist).add(1.0));
        const Hh = normalize(V.add(L));
        const NdotH = max(dot(N, Hh), 0.0);
        const VdotH = max(dot(V, Hh), 0.0);
        // GGX D
        const dDen = NdotH.mul(NdotH).mul(a.mul(a).sub(1.0)).add(1.0);
        const D = a.mul(a).div(dDen.mul(dDen).mul(PI).max(1e-6));
        // Smith G (Schlick-GGX, height-correlated approx)
        const k = a.mul(0.5);
        const gv = NdotV.div(NdotV.mul(float(1).sub(k)).add(k));
        const gl = NdotL.div(NdotL.mul(float(1).sub(k)).add(k));
        const G = gv.mul(gl);
        // Fresnel Schlick
        const F = F0.add(vec3(1).sub(F0).mul(pow(float(1).sub(VdotH), 5.0)));
        const spec = F.mul(D.mul(G).div(NdotV.mul(NdotL).mul(4).add(1e-4)));
        const kd = vec3(1).sub(F).mul(float(1).sub(metal));
        const diff = kd.mul(albedo).div(PI);
        const radiance = lcol.mul(lint).mul(atten);
        out.addAssign(diff.add(spec).mul(radiance).mul(NdotL));
      });
    });
    return out;
  })();

  // ---- CPU light state (animated demo set) ----
  const base = [];
  for (let i = 0; i < cfg.capLights; i++) {
    base.push({
      x: (Math.random() * 2 - 1) * 220, z: (Math.random() * 2 - 1) * 220,
      y: 3 + Math.random() * 5, phase: Math.random() * Math.PI * 2, drift: 8 + Math.random() * 20,
      r: 0.4 + Math.random() * 0.6, g: 0.4 + Math.random() * 0.6, b: 0.4 + Math.random() * 0.6,
      radius: 24 + Math.random() * 28, intensity: 28 + Math.random() * 36,
    });
  }
  const arr = lightAttr.array;
  function writeLights(t) {
    for (let i = 0; i < cfg.count; i++) {
      const L = base[i];
      const x = L.x + Math.sin(t * 0.3 + L.phase) * L.drift;
      const z = L.z + Math.cos(t * 0.27 + L.phase) * L.drift;
      const o = i * 8;
      arr[o] = x; arr[o + 1] = L.y; arr[o + 2] = z; arr[o + 3] = L.radius;
      arr[o + 4] = L.r; arr[o + 5] = L.g; arr[o + 6] = L.b; arr[o + 7] = L.intensity;
    }
    lightAttr.needsUpdate = true;
  }
  writeLights(0);

  return {
    pointLightTerm,
    async update(t) {
      camera.updateMatrixWorld();
      uView.value.copy(camera.matrixWorldInverse);
      uCamPos.value.copy(camera.position);
      writeLights(t);
      await renderer.computeAsync(cull);
    },
    setCount(n) { cfg.count = Math.max(0, Math.min(n | 0, cfg.capLights)); uCount.value = cfg.count; },
    resize(w, h) {
      const { tx, ty } = computeTiles(w, h);
      uScreen.value.set(w, h); uAspect.value = w / h;
      uTilesX.value = tx; uTilesY.value = ty; uFroxelCount.value = tx * ty * cfg.zSlices;
    },
    get lightCount() { return cfg.count; },
    get froxelCount() { return uFroxelCount.value; },
    dispose() { /* buffers GC with the nodes */ },
  };
}
