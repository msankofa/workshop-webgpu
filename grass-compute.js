// grass-compute.js
// GPU-driven grass: a per-frame compute pass regenerates candidate blades over a
// world-cell window around the camera, plants them on the TSL terrain height, culls
// (water / radius / density falloff), and atomicAdds survivors into a GPU-resident
// instance buffer that drives ONE drawIndexedIndirect. Placement is a pure function
// of (cell,slot) so blades never swim; the height function bit-matches
// terrain-field.js (Node-tested twin: grass-height-ref.js) so blades sit on the
// visible ground and water rejection matches the lakes. API forms confirmed by
// grass-compute-spike.html.
import * as THREE from 'three';
import {
  MeshStandardNodeMaterial, StorageInstancedBufferAttribute, StorageBufferAttribute,
  IndirectStorageBufferAttribute,
} from 'three/webgpu';
import {
  Fn, If, instanceIndex, storage, uniform, attribute, float, int, uint, bitcast, modInt,
  vec2, vec3, vec4, sin, cos, floor, mix, clamp, length, positionLocal,
  atomicAdd, atomicStore, atomicLoad, texture,
} from 'three/tsl';
import { buildBladeGeometry, buildGrassNoiseFns } from './grass.js';
import { maxInstances, perCellCount } from './grass-cells.js';

// ---- integer hash helpers (u32 domain; bit-exact with terrain-field/grass-cells) ----
// reinterpret an i32 node's bits as u32 (NOT a value conversion — preserves two's
// complement so negative cell indices hash like Math.imul/>>> in JS).
const asU = (iNode) => bitcast(iNode, 'uint');

// terrain-field lakeHash(ix,iz) → float in [0,1)
const lakeHashFn = Fn(([ix, iz]) => {
  let h = asU(ix).mul(uint(374761393)).bitXor(asU(iz).mul(uint(668265263)));
  h = h.bitXor(h.shiftRight(uint(13))).mul(uint(1274126177));
  h = h.bitXor(h.shiftRight(uint(16)));
  return h.toFloat().div(4294967296.0);
});

// terrain-field lakeNoise(x,z) (bilinear value noise over lakeHash)
const lakeNoiseFn = Fn(([x, z]) => {
  const fx = floor(x), fz = floor(z);
  const ix = int(fx), iz = int(fz);
  const u = x.sub(fx), v = z.sub(fz);
  const su = u.mul(u).mul(float(3).sub(u.mul(2)));
  const sv = v.mul(v).mul(float(3).sub(v.mul(2)));
  const a = lakeHashFn(ix, iz);
  const b = lakeHashFn(ix.add(int(1)), iz);
  const c = lakeHashFn(ix, iz.add(int(1)));
  const d = lakeHashFn(ix.add(int(1)), iz.add(int(1)));
  return mix(mix(a, b, su), mix(c, d, su), sv);
});

// generic per-(cell,slot,salt) pseudo-random in [0,1) for placement (determinism is
// all that matters here — not parity with terrain-field).
const slotRandFn = Fn(([gx, gz, slot, salt]) => {
  let h = asU(gx).mul(uint(1597334677)).bitXor(asU(gz).mul(uint(3812015801)));
  h = h.bitXor(h.shiftRight(uint(15))).mul(uint(2246822519));
  h = h.bitXor(asU(slot).add(uint(1)).mul(uint(2654435761)));
  h = h.bitXor(asU(salt).mul(uint(2246822519)));
  h = h.bitXor(h.shiftRight(uint(13))).mul(uint(3266489917));
  h = h.bitXor(h.shiftRight(uint(16)));
  return h.toFloat().div(4294967296.0);
});

export function createComputeGrass(opts) {
  const { renderer, camera } = opts;
  const recullMode = opts.grassRecull === 'frame' ? 'frame' : 'cell';
  const cellSize = opts.cellSize ?? 2;
  const Kmax     = opts.Kmax ?? 64;      // max blades/cell → max density = Kmax/cellSize² (=16 /unit²)
  // Buffer capacity is sized for maxRadius so the live Radius slider can grow up to it
  // without reallocating; the live radius starts at opts.radius.
  const maxRadius = opts.maxRadius ?? opts.radius ?? 600;
  const o = {
    density: opts.density ?? 8.0,        // blades / unit area
    radius:  Math.min(opts.radius ?? 350, maxRadius),
    waterLevel: opts.waterLevel ?? -0.9,
    shoreMargin: opts.shoreMargin ?? 0.1,
    baseAmp: opts.terrainParams?.baseAmp ?? 1.0,
    lake:    opts.terrainParams?.lake ?? 0.45,
    lakeDepth: opts.terrainParams?.lakeDepth ?? 3.2,
    cullStart: opts.cullStart ?? null,
    maxBlades: opts.maxBlades ?? 0,
    bladeHeight: opts.bladeHeight ?? 1.0,
    bladeWidth: opts.bladeWidth ?? 1.0,
    verticalOffset: opts.verticalOffset ?? 0.0,
  };
  const hasHeightTex = !!(opts.heightTex && opts.heightTexBounds);
  const heightTex = hasHeightTex ? opts.heightTex : null;
  const uBoundsMinX = hasHeightTex ? uniform(opts.heightTexBounds.minX) : null;
  const uBoundsMinZ = hasHeightTex ? uniform(opts.heightTexBounds.minZ) : null;
  const uBoundsW = hasHeightTex ? uniform(opts.heightTexBounds.worldX) : null;
  const uBoundsH = hasHeightTex ? uniform(opts.heightTexBounds.worldZ) : null;
  const half0 = Math.ceil(o.radius / cellSize) | 0;
  const CAP = maxInstances(maxRadius, cellSize, Kmax); // sized for the max radius (slider ceiling)

  // ---- buffers (GPU-resident; never re-uploaded per frame) ----
  // per instance: 2x vec4 → [2i]=(x,y,z,h), [2i+1]=(yaw,_,_,_)
  const instAttr = new StorageInstancedBufferAttribute(new Float32Array(CAP * 8), 8);
  const inst = storage(instAttr, 'vec4', CAP * 2);
  const counter = storage(new StorageBufferAttribute(new Uint32Array(1), 1), 'uint', 1).toAtomic();
  const indirectAttr = new IndirectStorageBufferAttribute(new Uint32Array([9, 0, 0, 0, 0]), 5);
  const indirect = storage(indirectAttr, 'uint', 5);

  // ---- uniforms (live) ----
  const uCam      = uniform(new THREE.Vector2());
  const uRadius   = uniform(o.radius);
  const uCullStart = uniform(o.cullStart !== null ? o.cullStart : o.radius * 0.8);
  const uMaxBlades = uniform(o.maxBlades, 'uint');
  const uHalf     = uniform(half0);
  const uSide     = uniform(2 * half0 + 1);
  const uPerCell  = uniform(perCellCount(o.density, cellSize, Kmax));
  const uCellSize = uniform(cellSize);
  const uWaterMin = uniform(o.waterLevel + o.shoreMargin);
  const uBaseAmp  = uniform(o.baseAmp);
  const uLake     = uniform(o.lake);
  const uLakeDepth= uniform(o.lakeDepth);
  const uTime     = uniform(0);
  const uWindSpeed= uniform(2.0);
  const uWindFreq = uniform(0.3);    // wind wave spatial freq per world unit (seam-free)
  const uTipDist  = uniform(0.3);
  const uCenterDist = uniform(0.1);
  const uBladeHeight = uniform(o.bladeHeight);
  const uBladeWidth = uniform(o.bladeWidth);
  const uVerticalOffset = uniform(o.verticalOffset);
  let dirty = true;
  let lastCellX = null;
  let lastCellZ = null;
  const stats = {
    recullMode,
    reculls: 0,
    skippedReculls: 0,
    lastCell: '',
    dirty: true,
  };
  const markDirty = () => {
    dirty = true;
    stats.dirty = true;
  };

  // TSL terrain height: texture path for authored maps, closed-form for procedural.
  const heightFn = hasHeightTex
    ? Fn(([x, z]) => {
        const u = clamp(x.sub(uBoundsMinX).div(uBoundsW), 0, 1);
        const v = clamp(z.sub(uBoundsMinZ).div(uBoundsH), 0, 1);
        return texture(heightTex, vec2(u, v)).r;
      })
    : Fn(([x, z]) => {
        const h = sin(x.mul(0.10)).mul(1.1)
          .add(cos(z.mul(0.085)).mul(1.0))
          .add(sin(x.add(z).mul(0.16)).mul(0.5))
          .add(cos(x.sub(z).mul(0.22).add(0.8)).mul(0.35))
          .add(sin(x.mul(0.38).add(z.mul(0.27))).mul(0.18))
          .add(cos(z.mul(0.44).sub(x.mul(0.19))).mul(0.14))
          .mul(uBaseAmp);
        const t = float(1).sub(uLake);
        const nz = lakeNoiseFn(x.mul(0.045).add(10.5), z.mul(0.045).sub(7.2));
        const basin = clamp(nz.sub(t).div(0.15), 0, 1);
        const basinSS = basin.mul(basin).mul(float(3).sub(basin.mul(2)));
        return h.sub(basinSS.mul(uLakeDepth));
      });

  // ---- compute kernels (reset → generate+cull → finalize), per the spike ----
  const reset = Fn(() => { atomicStore(counter.element(0), uint(0)); })().compute(1);

  const cull = Fn(() => {
    const idx = int(instanceIndex);                  // 0 .. CAP-1 (CAP is small; int is safe)
    const K = int(Kmax);
    const slot = modInt(idx, K);
    If(slot.lessThan(int(uPerCell)), () => {         // only first uPerCell slots per cell are live
      const cellI = idx.sub(slot).div(K);            // integer cell index in the window (int domain)
      const side = int(uSide);
      const lx = modInt(cellI, side);
      const lz = cellI.sub(lx).div(side);
      const camGx = int(floor(uCam.x.div(uCellSize)));
      const camGz = int(floor(uCam.y.div(uCellSize)));
      const gx = camGx.add(lx).sub(int(uHalf));
      const gz = camGz.add(lz).sub(int(uHalf));
      const jx = slotRandFn(gx, gz, slot, int(1));
      const jz = slotRandFn(gx, gz, slot, int(2));
      const wx = gx.toFloat().mul(uCellSize).add(jx.mul(uCellSize));
      const wz = gz.toFloat().mul(uCellSize).add(jz.mul(uCellSize));
      const wy = heightFn(wx, wz);
      const dist = length(vec2(wx.sub(uCam.x), wz.sub(uCam.y)));
      const gradRange = uRadius.sub(uCullStart).max(float(0.001));
      const edge = clamp(dist.sub(uCullStart).div(gradRange), 0, 1);
      const keepRand = slotRandFn(gx, gz, slot, int(7));
      const live = wy.greaterThan(uWaterMin)
        .and(dist.lessThan(uRadius))
        .and(keepRand.greaterThan(edge));
      If(live, () => {
        const s = atomicAdd(counter.element(0), uint(1));
        const withinCap = uMaxBlades.equal(uint(0)).or(s.lessThan(uMaxBlades));
        If(withinCap, () => {
          const base2 = s.mul(uint(2));
          const yaw = slotRandFn(gx, gz, slot, int(3)).mul(6.2831853);
          const bh = float(0.8).add(slotRandFn(gx, gz, slot, int(5)).mul(0.6));
          inst.element(base2).assign(vec4(wx, wy, wz, bh));
          inst.element(base2.add(uint(1))).assign(vec4(yaw, 0, 0, 0));
        });
      });
    });
  })().compute(CAP);

  const finalize = Fn(() => {
    const c = atomicLoad(counter.element(0));
    indirect.element(1).assign(c);
    If(uMaxBlades.greaterThan(uint(0)).and(c.greaterThan(uMaxBlades)), () => {
      indirect.element(1).assign(uMaxBlades);
    });
  })().compute(1);

  // ---- instanced base blade + node material ----
  const geom = buildBladeGeometry();
  geom.instanceCount = CAP;
  geom.indirect = indirectAttr;          // exact form per the spike

  const aWind = attribute('aWind', 'float');
  const rec0 = inst.element(instanceIndex.mul(uint(2)));        // (x,y,z,h)
  const rec1 = inst.element(instanceIndex.mul(uint(2)).add(uint(1))); // (yaw,...)
  const base = rec0.xyz, bladeH = rec0.w, yaw = rec1.x;

  // rotate local blade (width axis = local X, blade in XY plane, z=0) by yaw, scale height
  const cy = cos(yaw), sy = sin(yaw);
  const bladeX = positionLocal.x.mul(uBladeWidth);
  const rx = bladeX.mul(cy);
  const rz = bladeX.mul(sy);
  const ly = positionLocal.y.mul(bladeH.div(0.8)).mul(uBladeHeight);

  const worldX = base.x.add(rx);
  const wave = sin(uTime.mul(uWindSpeed).add(worldX.mul(uWindFreq)));
  const isMidTip = clamp(aWind.mul(2), 0, 1);
  const isTip = clamp(aWind.sub(0.6).mul(10), 0, 1);
  const sway = wave.mul(isMidTip.mul(mix(uCenterDist, uTipDist, isTip)));
  const posNode = vec3(worldX.add(sway), base.y.add(uVerticalOffset).add(ly), base.z.add(rz));

  const { noise2D } = buildGrassNoiseFns();
  const uBaseColor = uniform(new THREE.Color(0x16240e));
  const uTipColor  = uniform(new THREE.Color(0x5a8a32));
  const uAmbient = uniform(0.55), uKey = uniform(0.55);
  const uCloudStr = uniform(0.35), uCloudScale = uniform(0.02);
  const cloud = float(1).sub(uCloudStr.mul(noise2D(vec2(base.x, base.z).mul(uCloudScale))));
  const colorNode = mix(uBaseColor, uTipColor, aWind).mul(uAmbient.add(uKey)).mul(cloud);

  const mat = new MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 1, metalness: 0 });
  mat.positionNode = posNode;
  mat.colorNode = colorNode;
  mat.normalNode = vec3(0, 1, 0);
  // SP4a: optional additive clustered point-light term. Sample at the blade's ground-planted
  // BASE (not the swaying elevated tip) so grass lighting stays locked to the terrain pool
  // directly beneath it — avoids height-parallax desync as lights move.
  if (opts.addEmissive) mat.emissiveNode = opts.addEmissive(base, vec3(0, 1, 0));

  const mesh = new THREE.Mesh(geom, mat);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = true;

  return {
    mesh,
    // Awaited so the reset→cull→finalize chain is submitted before the frame's draw
    // reads the indirect instanceCount (unawaited fire-and-forget races the draw and
    // makes the grass blink). Mirrors the validated spike's computeAsync ordering.
    async update(seconds) {
      uTime.value = seconds;
      const cellX = Math.floor(camera.position.x / cellSize);
      const cellZ = Math.floor(camera.position.z / cellSize);
      const cellChanged = cellX !== lastCellX || cellZ !== lastCellZ;
      stats.lastCell = `${cellX}:${cellZ}`;
      if (recullMode !== 'frame' && !dirty && !cellChanged) {
        stats.skippedReculls++;
        return;
      }
      uCam.value.set(camera.position.x, camera.position.z);
      await renderer.computeAsync([reset, cull, finalize]);
      lastCellX = cellX;
      lastCellZ = cellZ;
      dirty = false;
      stats.dirty = false;
      stats.reculls++;
    },
    forceRecull: markDirty,
    stats,
    setDensity(d) {
      const perCell = perCellCount(d, cellSize, Kmax);
      if (uPerCell.value === perCell) return;
      uPerCell.value = perCell;
      markDirty();
    },
    setRadius(r) {
      r = Math.min(r, maxRadius);                       // never exceed the buffer capacity
      const half = Math.ceil(r / cellSize) | 0;
      if (uRadius.value === r && uHalf.value === half && uSide.value === 2 * half + 1) return;
      uRadius.value = r; uHalf.value = half; uSide.value = 2 * half + 1;
      if (o.cullStart === null) uCullStart.value = r * 0.8;
      markDirty();
    },
    setCullStart(wu) {
      const v = Math.max(0, Math.min(wu, uRadius.value));
      if (uCullStart.value === v) return;
      o.cullStart = v;
      uCullStart.value = v;
      markDirty();
    },
    setMaxBlades(n) {
      const v = Math.max(0, n) >>> 0;
      if (uMaxBlades.value === v) return;
      uMaxBlades.value = v;
      markDirty();
    },
    setBladeHeight(v) {
      v = Math.max(0.05, Number(v) || 0.05);
      if (uBladeHeight.value === v) return;
      uBladeHeight.value = v;
    },
    setBladeWidth(v) {
      v = Math.max(0.05, Number(v) || 0.05);
      if (uBladeWidth.value === v) return;
      uBladeWidth.value = v;
    },
    setVerticalOffset(v) {
      v = Number(v) || 0;
      if (uVerticalOffset.value === v) return;
      uVerticalOffset.value = v;
    },
    maxRadius,
    setWind(strength) { uTipDist.value = 0.3 * strength; uCenterDist.value = 0.1 * strength; },
    setTerrain(p) {
      let changed = false;
      if (p.baseAmp !== undefined && uBaseAmp.value !== p.baseAmp) { uBaseAmp.value = p.baseAmp; changed = true; }
      if (p.lake !== undefined && uLake.value !== p.lake) { uLake.value = p.lake; changed = true; }
      if (p.lakeDepth !== undefined && uLakeDepth.value !== p.lakeDepth) { uLakeDepth.value = p.lakeDepth; changed = true; }
      if (changed) markDirty();
    },
    setWaterLevel(wl) {
      const waterMin = wl + o.shoreMargin;
      if (uWaterMin.value === waterMin) return;
      uWaterMin.value = waterMin;
      markDirty();
    },
    dispose() { geom.dispose(); mat.dispose(); },
  };
}
