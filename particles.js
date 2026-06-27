// particles.js
// SP4b — GPU-driven particle field (embers / dust). A persistent GPU state buffer is simulated
// each frame by a compute pass (curl-noise drift + buoyancy/wind + lifecycle/respawn), and the
// alive+visible particles are atomicAdd'd into one drawIndexedIndirect of camera-facing
// billboards. Mirrors the SP2/SP3/4a compute→indirect spine. Sim math twin: particle-field.js
// (Node-tested); the GPU uses equivalent (not bit-exact) randomness — particles are purely
// visual, so no cross-system parity is required.
import * as THREE from 'three';
import {
  MeshBasicNodeMaterial, StorageBufferAttribute, StorageInstancedBufferAttribute,
  IndirectStorageBufferAttribute,
} from 'three/webgpu';
import {
  Fn, If, instanceIndex, storage, uniform, attribute, float, int, uint, bitcast,
  vec2, vec3, vec4, sin, cos, floor, max, min, abs, clamp, mix, atomicAdd, atomicStore, atomicLoad,
} from 'three/tsl';
import { buildGrassNoiseFns } from './grass.js';
import { kindParams } from './particle-field.js';

const asU = (i) => bitcast(i, 'uint');

export function createParticleField(opts) {
  const { renderer, camera } = opts;
  const kind = opts.kind ?? 'ember';
  // Resolved params: per-species defaults, overridden by any caller-supplied values so a
  // field can be spawned fully custom (the editor passes its slider values here).
  const P = { ...kindParams(kind), ...(opts.params || {}) };
  const CAP = opts.count ?? (kind === 'dust' ? 8000 : 4000);
  const R = opts.radius ?? 90;

  // ---- buffers ----
  // state: persistent (px,py,pz,age),(vx,vy,vz,seed)
  const stateAttr = new StorageBufferAttribute(new Float32Array(CAP * 8), 4);
  const state = storage(stateAttr, 'vec4', CAP * 2);
  const counter = storage(new StorageBufferAttribute(new Uint32Array(1), 1), 'uint', 1).toAtomic();
  const indirectAttr = new IndirectStorageBufferAttribute(new Uint32Array([6, 0, 0, 0, 0]), 5);
  const indirect = storage(indirectAttr, 'uint', 5);
  // draw survivors: (px,py,pz,size),(r,g,b,alpha)
  const drawAttr = new StorageInstancedBufferAttribute(new Float32Array(CAP * 8), 4);
  const drawBuf = storage(drawAttr, 'vec4', CAP * 2);

  // ---- init state on the CPU (once) ----
  {
    const a = stateAttr.array;
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    for (let i = 0; i < CAP; i++) {
      const o = i * 8;
      a[o] = cx + (Math.random() * 2 - 1) * R;
      a[o + 1] = cy + (Math.random() * 2 - 1) * R;
      a[o + 2] = cz + (Math.random() * 2 - 1) * R;
      a[o + 3] = Math.random() * P.maxLife;             // staggered age
      a[o + 4] = (Math.random() * 2 - 1) * 0.2;
      a[o + 5] = Math.random() * 0.3;
      a[o + 6] = (Math.random() * 2 - 1) * 0.2;
      a[o + 7] = i;                                       // seed
    }
    stateAttr.needsUpdate = true;
  }

  // ---- uniforms ----
  const uCamPos = uniform(new THREE.Vector3());
  const uCamRight = uniform(new THREE.Vector3());
  const uCamUp = uniform(new THREE.Vector3());
  const uViewProj = uniform(new THREE.Matrix4());
  const uTime = uniform(0);
  const uDt = uniform(0.016);
  const uFrame = uniform(0);
  const uR = uniform(R);
  const uBuoy = uniform(P.buoyancy);
  const uDrag = uniform(P.drag);
  const uCurl = uniform(P.curlStrength);
  const uWind = uniform(new THREE.Vector2(P.wind[0], P.wind[1]));
  const uSize = uniform(P.size);
  const uColor = uniform(new THREE.Color(P.color[0], P.color[1], P.color[2]));
  const uAlpha = uniform(P.alpha);
  const uFlicker = uniform(P.flicker);
  const uMaxLife = uniform(P.maxLife);
  const uSpeed = uniform(P.speed);

  const { noise2D } = buildGrassNoiseFns();
  // curl of the noise potential (divergence-free) — matches particle-field.curlNoise2
  const curlFn = Fn(([x, z]) => {
    const e = float(0.35);
    const fx = noise2D(vec2(x, z.add(e))).sub(noise2D(vec2(x, z.sub(e)))).div(e.mul(2));
    const fz = noise2D(vec2(x.add(e), z)).sub(noise2D(vec2(x.sub(e), z))).div(e.mul(2)).negate();
    return vec2(fx, fz);
  });
  // cheap per-(seed,salt) random in [0,1)
  const randFn = Fn(([seed, salt]) => {
    let h = asU(seed).mul(uint(2654435761)).bitXor(asU(salt).add(uint(1)).mul(uint(1597334677)));
    h = h.bitXor(h.shiftRight(uint(15))).mul(uint(2246822519));
    h = h.bitXor(h.shiftRight(uint(13)));
    return h.toFloat().div(4294967296.0);
  });

  // ---- compute: reset → simulate → finalize ----
  const reset = Fn(() => { atomicStore(counter.element(0), uint(0)); })().compute(1);

  const simulate = Fn(() => {
    const i = int(instanceIndex);
    const rec0 = state.element(i.mul(2));
    const rec1 = state.element(i.mul(2).add(1));
    const pos = rec0.xyz.toVar();
    const age = rec0.w.toVar();
    const vel = rec1.xyz.toVar();
    const seed = int(rec1.w);

    // forces: curl drift + buoyancy (up) + wind
    const c = curlFn(pos.x, pos.z).mul(uCurl);
    const force = vec3(c.x.add(uWind.x), uBuoy, c.y.add(uWind.y));
    vel.assign(vel.add(force.mul(uDt)).mul(max(float(0), float(1).sub(uDrag.mul(uDt)))));
    pos.assign(pos.add(vel.mul(uSpeed).mul(uDt)));
    age.assign(age.add(uDt));

    // respawn on death or leaving the camera volume
    const distXZ = abs(pos.x.sub(uCamPos.x)).max(abs(pos.z.sub(uCamPos.z)));
    const dead = age.greaterThan(uMaxLife).or(distXZ.greaterThan(uR.mul(1.2)));
    If(dead, () => {
      const salt = int(uFrame).add(seed);
      pos.assign(vec3(
        uCamPos.x.add(randFn(seed, salt).mul(2).sub(1).mul(uR)),
        uCamPos.y.add(randFn(seed, salt.add(7)).mul(2).sub(1).mul(uR)),
        uCamPos.z.add(randFn(seed, salt.add(13)).mul(2).sub(1).mul(uR)),
      ));
      vel.assign(vec3(randFn(seed, salt.add(3)).sub(0.5).mul(0.4), randFn(seed, salt.add(5)).mul(0.3), randFn(seed, salt.add(9)).sub(0.5).mul(0.4)));
      age.assign(0.0);
    });

    // write state back
    state.element(i.mul(2)).assign(vec4(pos, age));
    state.element(i.mul(2).add(1)).assign(vec4(vel, rec1.w));

    // fade envelope + flicker
    const f = float(0.15).mul(uMaxLife);
    const fade = clamp(age.div(f), 0, 1).mul(clamp(uMaxLife.sub(age).div(f), 0, 1));
    const flick = float(1).add(uFlicker.mul(sin(uTime.mul(8).add(seed.toFloat()))));
    const size = uSize.mul(fade);

    // frustum cull → emit survivor
    const clip = uViewProj.mul(vec4(pos, 1.0));
    const visible = clip.w.greaterThan(0.0)
      .and(abs(clip.x).lessThan(clip.w.mul(1.3)))
      .and(abs(clip.y).lessThan(clip.w.mul(1.3)))
      .and(fade.greaterThan(0.01));
    If(visible, () => {
      const s = atomicAdd(counter.element(0), uint(1));
      drawBuf.element(s.mul(uint(2))).assign(vec4(pos, size));
      drawBuf.element(s.mul(uint(2)).add(uint(1))).assign(vec4(uColor.mul(flick), uAlpha.mul(fade)));
    });
  })().compute(CAP);

  const finalize = Fn(() => { indirect.element(1).assign(atomicLoad(counter.element(0))); })().compute(1);

  // ---- billboard geometry (quad) + material ----
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('aCorner', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5]), 2));
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(4 * 3), 3));
  geo.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
  geo.instanceCount = CAP;
  geo.indirect = indirectAttr;

  const aCorner = attribute('aCorner', 'vec2');
  const rec = drawBuf.element(instanceIndex.mul(uint(2)));
  const rec1d = drawBuf.element(instanceIndex.mul(uint(2)).add(uint(1)));
  const pPos = rec.xyz, pSize = rec.w;
  const posNode = pPos.add(uCamRight.mul(aCorner.x.mul(pSize))).add(uCamUp.mul(aCorner.y.mul(pSize)));

  const mat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  mat.positionNode = posNode;
  mat.colorNode = rec1d.xyz;
  mat.opacityNode = rec1d.w;
  mat.blending = kind === 'ember' ? THREE.AdditiveBlending : THREE.NormalBlending;

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;

  const _r = new THREE.Vector3(), _u = new THREE.Vector3(), _f = new THREE.Vector3();
  let frame = 0;
  let enabled = true;
  return {
    mesh,
    kind,
    async update(dt, cam) {
      if (!enabled) return;       // disabled fields skip the GPU sim entirely
      frame++;
      cam.updateMatrixWorld();
      cam.matrixWorld.extractBasis(_r, _u, _f);
      uCamRight.value.copy(_r); uCamUp.value.copy(_u); uCamPos.value.copy(cam.position);
      uViewProj.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      uTime.value += dt; uDt.value = Math.min(dt, 0.05); uFrame.value = frame;
      await renderer.computeAsync([reset, simulate, finalize]);
    },
    // Live uniform tuning — every key is optional; only supplied ones are written.
    setParams(p) {
      if (p.size      !== undefined) uSize.value    = p.size;
      if (p.alpha     !== undefined) uAlpha.value   = p.alpha;
      if (p.flicker   !== undefined) uFlicker.value = p.flicker;
      if (p.buoyancy  !== undefined) uBuoy.value    = p.buoyancy;
      if (p.drag      !== undefined) uDrag.value    = p.drag;
      if (p.curlStrength !== undefined) uCurl.value = p.curlStrength;
      if (p.speed     !== undefined) uSpeed.value   = p.speed;
      if (p.maxLife   !== undefined) uMaxLife.value = p.maxLife;
      if (p.wind)  uWind.value.set(p.wind[0], p.wind[1]);
      if (p.color) uColor.value.setRGB(p.color[0], p.color[1], p.color[2]);
    },
    setEnabled(on) { enabled = on; mesh.visible = on; },
    get enabled() { return enabled; },
    get defaults() { return { ...P, kind, count: CAP, radius: R }; },
    get count() { return CAP; },
    dispose() { geo.dispose(); mat.dispose(); },
  };
}
