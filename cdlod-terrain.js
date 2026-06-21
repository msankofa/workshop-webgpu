// cdlod-terrain.js
// GPU-driven CDLOD terrain (SP3). Per frame: a compute pass evaluates a camera-snapped,
// Morton-keyed quadtree window (cdlod-select.js math, transcribed to TSL), flat-tests each
// candidate node's LOD band, and atomicAdds survivors into a GPU-resident instance buffer
// that drives ONE drawIndexedIndirect of a reusable PATCH×PATCH grid. The vertex stage
// applies CDLOD morphing, then displaces by the analytic height (bit-matching
// grass-height-ref.js / terrain-field.js) and shades with the analytic normal. Mirrors
// grass-compute.js (awaited computeAsync chain to avoid the indirect-vs-draw race; int
// indices decomposed with modInt + exact-multiple division, never float .div/.mod).
import * as THREE from 'three';
import {
  MeshStandardNodeMaterial, StorageInstancedBufferAttribute, StorageBufferAttribute,
  IndirectStorageBufferAttribute,
} from 'three/webgpu';
import {
  Fn, If, instanceIndex, storage, uniform, attribute, float, int, uint, bitcast, modInt,
  vec2, vec3, vec4, sin, cos, floor, max, clamp, sqrt, exp2, mix,
  atomicAdd, atomicStore, atomicLoad,
} from 'three/tsl';
import { selectNodes } from './cdlod-select.js';

const DEF = { leafSize: 16, levels: 7, patchQuads: 16, lodScale: 2.5, morphStart: 0.6, windowCells: 8 };

// Reusable indexed grid over [0,1]^2 with q*q cells. aGrid carries (gx,gz) in [0,1].
function buildPatchGeometry(q) {
  const g1 = q + 1, vcount = g1 * g1;
  const grid = new Float32Array(vcount * 2);
  let p = 0;
  for (let iz = 0; iz <= q; iz++) for (let ix = 0; ix <= q; ix++) { grid[p++] = ix / q; grid[p++] = iz / q; }
  const index = new Uint16Array(q * q * 6);
  let t = 0;
  for (let iz = 0; iz < q; iz++) for (let ix = 0; ix < q; ix++) {
    const a = ix + g1 * iz, b = ix + g1 * (iz + 1), c = (ix + 1) + g1 * (iz + 1), d = (ix + 1) + g1 * iz;
    index[t++] = a; index[t++] = b; index[t++] = d; index[t++] = b; index[t++] = c; index[t++] = d;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('aGrid', new THREE.BufferAttribute(grid, 2));
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vcount * 3), 3)); // placeholder; positionNode overrides
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  return { geo, indexCount: index.length };
}

const asU = (i) => bitcast(i, 'uint');

export function createCdlodTerrain(opts) {
  const { renderer, camera } = opts;
  const cfg = { ...DEF, ...(opts.cfg || {}) };
  const q = cfg.patchQuads;
  const CANDIDATES = cfg.levels * cfg.windowCells * cfg.windowCells; // dispatch + survivor cap
  const half = Math.floor(cfg.windowCells / 2);

  const o = {
    baseAmp: opts.terrainParams?.baseAmp ?? 1.0,
    lake: opts.terrainParams?.lake ?? 0.45,
    lakeDepth: opts.terrainParams?.lakeDepth ?? 3.2,
  };
  // live CPU mirror of cfg.levels so the HUD survivor count tracks setViewDistance
  let activeLevels = cfg.levels;

  // ---- buffers: per node 1x vec4 = (originX, originZ, size, packed[level + morphK]) ----
  const instAttr = new StorageInstancedBufferAttribute(new Float32Array(CANDIDATES * 4), 4);
  const inst = storage(instAttr, 'vec4', CANDIDATES);
  const counter = storage(new StorageBufferAttribute(new Uint32Array(1), 1), 'uint', 1).toAtomic();
  const { geo, indexCount } = buildPatchGeometry(q);
  const indirectAttr = new IndirectStorageBufferAttribute(new Uint32Array([indexCount, 0, 0, 0, 0]), 5);
  const indirect = storage(indirectAttr, 'uint', 5);

  // ---- uniforms ----
  const uCam = uniform(new THREE.Vector2());
  const uLevels = uniform(cfg.levels);
  const uLeaf = uniform(cfg.leafSize);
  const uLodScale = uniform(cfg.lodScale);
  const uMorphStart = uniform(cfg.morphStart);
  const uHalf = uniform(half);
  const uWin = uniform(cfg.windowCells);
  const uBaseAmp = uniform(o.baseAmp), uLake = uniform(o.lake), uLakeDepth = uniform(o.lakeDepth);

  // ---- analytic field in TSL (transcription of grass-height-ref.js) ----
  const lakeHashFn = Fn(([ix, iz]) => {
    let h = asU(ix).mul(uint(374761393)).bitXor(asU(iz).mul(uint(668265263)));
    h = h.bitXor(h.shiftRight(uint(13))).mul(uint(1274126177));
    h = h.bitXor(h.shiftRight(uint(16)));
    return h.toFloat().div(4294967296.0);
  });
  const lakeNoiseFn = Fn(([x, z]) => {
    const fx = floor(x), fz = floor(z);
    const ix = int(fx), iz = int(fz);
    const u = x.sub(fx), v = z.sub(fz);
    const su = u.mul(u).mul(float(3).sub(u.mul(2)));
    const sv = v.mul(v).mul(float(3).sub(v.mul(2)));
    const a = lakeHashFn(ix, iz), b = lakeHashFn(ix.add(int(1)), iz);
    const c = lakeHashFn(ix, iz.add(int(1))), d = lakeHashFn(ix.add(int(1)), iz.add(int(1)));
    return mix(mix(a, b, su), mix(c, d, su), sv);
  });
  const heightFn = Fn(([x, z]) => {
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

  // min distance (XZ) from camera to cell [ox,ox+s]x[oz,oz+s]
  const minDistFn = Fn(([ox, oz, s, cx, cz]) => {
    const dx = max(max(ox.sub(cx), cx.sub(ox.add(s))), 0);
    const dz = max(max(oz.sub(cz), cz.sub(oz.add(s))), 0);
    return sqrt(dx.mul(dx).add(dz.mul(dz)));
  });
  // range / size at a level (float L): leaf * 2^L * lodScale  and  leaf * 2^L
  const rangeFn = Fn(([L]) => uLeaf.mul(exp2(L)).mul(uLodScale));
  const sizeFn = Fn(([L]) => uLeaf.mul(exp2(L)));

  // ---- compute: reset → select → finalize ----
  const reset = Fn(() => { atomicStore(counter.element(0), uint(0)); })().compute(1);

  const select = Fn(() => {
    const idx = int(instanceIndex);                       // 0 .. CANDIDATES-1
    const win = int(uWin);
    const cellsPerLevel = win.mul(win);
    // decompose idx -> (L, lx, lz) using modInt + exact-multiple division (never float .div)
    const inLevel = modInt(idx, cellsPerLevel);
    const L = idx.sub(inLevel).div(cellsPerLevel);
    const lxRaw = modInt(inLevel, win);
    const lzRaw = inLevel.sub(lxRaw).div(win);
    const lx = lxRaw.sub(int(uHalf));
    const lz = lzRaw.sub(int(uHalf));
    const Lf = L.toFloat();
    const s = sizeFn(Lf);
    const cCellX = int(floor(uCam.x.div(s)));
    const cCellZ = int(floor(uCam.y.div(s)));
    const ix = cCellX.add(lx);
    const iz = cCellZ.add(lz);
    const ox = ix.toFloat().mul(s);
    const oz = iz.toFloat().mul(s);
    const d = minDistFn(ox, oz, s, uCam.x, uCam.y);
    const rangeL = rangeFn(Lf);

    // notRefined: L==0 OR d > range[L-1]
    const rangeInner = rangeFn(Lf.sub(1));
    const notRefined = L.equal(int(0)).or(d.greaterThan(rangeInner));
    // refinedByParent: L==levels-1 OR parentMinDist <= range[L]
    const ps = sizeFn(Lf.add(1));
    const pIx = floor(ix.toFloat().mul(0.5));      // parent cell index (float floor handles negatives)
    const pIz = floor(iz.toFloat().mul(0.5));
    const pd = minDistFn(pIx.mul(ps), pIz.mul(ps), ps, uCam.x, uCam.y);
    const refinedByParent = L.equal(int(uLevels).sub(int(1))).or(pd.lessThanEqual(rangeL));

    If(notRefined.and(refinedByParent), () => {
      // morphK = clamp((d - morphStart*range)/((1-morphStart)*range), 0, 1)
      const startD = uMorphStart.mul(rangeL);
      const morphK = clamp(d.sub(startD).div(max(rangeL.sub(startD), 0.0001)), 0, 1);
      const sIdx = atomicAdd(counter.element(0), uint(1));
      // pack level into integer part, morphK into fraction (level<256, morphK in [0,1))
      const packed = Lf.add(morphK.mul(0.999));
      inst.element(sIdx).assign(vec4(ox, oz, s, packed));
    });
  })().compute(CANDIDATES);

  const finalize = Fn(() => { indirect.element(1).assign(atomicLoad(counter.element(0))); })().compute(1);

  // ---- node material: morph grid coord, displace by analytic height, analytic normal ----
  geo.instanceCount = CANDIDATES;
  geo.indirect = indirectAttr;

  const aGrid = attribute('aGrid', 'vec2');
  const rec = inst.element(instanceIndex);             // (ox, oz, size, packed)
  const recOx = rec.x, recOz = rec.y, recS = rec.z;
  const level = floor(rec.w);
  const morphK = rec.w.sub(level).div(0.999);

  // CDLOD morph on each grid axis: pull odd verts toward the even (parent) lattice
  const Nf = float(q);
  const morphAxis = Fn(([g]) => {
    const gi = g.mul(Nf);
    const fr = gi.mul(0.5).sub(floor(gi.mul(0.5)));    // 0 on even, 0.5 on odd
    return g.sub(fr.mul(2).div(Nf).mul(morphK));
  });
  const gX = morphAxis(aGrid.x);
  const gZ = morphAxis(aGrid.y);
  const wx = recOx.add(gX.mul(recS));
  const wz = recOz.add(gZ.mul(recS));
  const wy = heightFn(wx, wz);
  const posNode = vec3(wx, wy, wz);

  // analytic normal via central difference of heightFn (matches terrainNormalAt, e=0.5)
  const e = float(0.5);
  const nL = heightFn(wx.sub(e), wz), nR = heightFn(wx.add(e), wz);
  const nD = heightFn(wx, wz.sub(e)), nU = heightFn(wx, wz.add(e));
  const nrm = vec3(nL.sub(nR), e.mul(2), nD.sub(nU));

  const mat = new MeshStandardNodeMaterial({ color: 0x2a2f38, roughness: 1, metalness: 0 });
  mat.positionNode = posNode;
  mat.normalNode = nrm.normalize();

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.name = 'CdlodTerrain';

  // CPU mirror of the survivor count for the HUD (the GPU writes the indirect instanceCount
  // into the GPU buffer; it is not synced back to indirectAttr.array, so we recompute the
  // identical selection on the CPU — 448 cheap iterations, HUD-only, off the render path).
  function survivorCount() {
    return selectNodes({ ...cfg, levels: activeLevels }, camera.position.x, camera.position.z).length;
  }

  return {
    mesh,
    async update() {
      uCam.value.set(camera.position.x, camera.position.z);
      await renderer.computeAsync(reset);
      await renderer.computeAsync(select);
      await renderer.computeAsync(finalize);
    },
    setViewDistance(levels) {
      activeLevels = Math.max(2, Math.min(cfg.levels, Math.round(levels)));
      uLevels.value = activeLevels;
    },
    maxLevels: cfg.levels,
    setTerrain(p) { uBaseAmp.value = p.baseAmp; uLake.value = p.lake; uLakeDepth.value = p.lakeDepth; },
    setWaterLevel() { /* terrain ground ignores water level; kept for API symmetry with grass */ },
    get triangleCount() { return (indexCount / 3) * survivorCount(); },
    get drawCount() { return 1; },
    dispose() { geo.dispose(); mat.dispose(); },
  };
}
