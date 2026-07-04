// plants-gpu.js -- GPU-instanced procedural plants. Mirrors forest-gpu.js's
// reset -> cull -> finalize -> indirect-draw spine, simplified to a single distance-cull
// band and one mesh per variant (buildPlantGeometry bakes stem+leaves+flowers+vertex-color
// into ONE geometry per variant, unlike forest's separate branches/leaves/shadow meshes).
import * as THREE from 'three';
import {
  MeshStandardNodeMaterial, StorageInstancedBufferAttribute, StorageBufferAttribute,
  IndirectStorageBufferAttribute,
} from 'three/webgpu';
import {
  Fn, If, instanceIndex, storage, uniform, int, uint, float, vec2,
  vec3, cos, sin, modInt, positionLocal, normalLocal, clamp, length, floor, bitcast,
  atomicAdd, atomicStore, atomicLoad,
} from 'three/tsl';

// reinterpret an i32 node's bits as u32 (same trick grass-compute.js uses) so negative
// quantized coordinates hash like Math.imul/>>> in JS instead of throwing/wrapping oddly.
const asU = (iNode) => bitcast(iNode, 'uint');

// per-(worldX,worldZ,salt) pseudo-random in [0,1), keyed by quantized *position* rather
// than buffer slot index -- unlike grass's anchor/slot-index hashes, this stays stable
// across rebuild() calls even though rebuild() re-sorts and reassigns buffer slots every
// time (see rebuild()'s distance sort below), since a given plant's own world position
// never changes when its slot does.
const posRandFn = Fn(([x, z, salt]) => {
  const ix = asU(int(floor(x.mul(8.0))));
  const iz = asU(int(floor(z.mul(8.0))));
  let h = ix.mul(uint(1597334677)).bitXor(iz.mul(uint(3812015801)));
  h = h.bitXor(h.shiftRight(uint(15))).mul(uint(2246822519));
  h = h.bitXor(asU(salt).mul(uint(2654435761)));
  h = h.bitXor(h.shiftRight(uint(13))).mul(uint(3266489917));
  h = h.bitXor(h.shiftRight(uint(16)));
  return h.toFloat().div(4294967296.0);
});

// opts: { renderer, camera, palette (from plants.js's createPlantPalette), heightAt,
//         capPerVariant, cullRadius, cullStart }
export function createPlantsGPU(opts) {
  const { renderer, camera, palette } = opts;
  const heightAt = opts.heightAt || (() => 0);
  const CAP = opts.capPerVariant ?? 256;
  const V = palette.variants.length;

  // source (CPU-filled on chunk change) and draw (compute-written survivors) buffers:
  // V*CAP instances x 2 vec4 -> rec0=(x,y,z,scale), rec1=(yaw,_,_,_).
  const srcAttr = new StorageInstancedBufferAttribute(new Float32Array(V * CAP * 8), 8);
  const src = storage(srcAttr, 'vec4', V * CAP * 2);
  const drawAttr = new StorageInstancedBufferAttribute(new Float32Array(V * CAP * 8), 8);
  const draw = storage(drawAttr, 'vec4', V * CAP * 2);
  const countsAttr = new StorageBufferAttribute(new Uint32Array(V), 1);
  const srcCounts = storage(countsAttr, 'uint', V);
  const survAtomics = storage(new StorageBufferAttribute(new Uint32Array(V), 1), 'uint', V).toAtomic();

  // geo.index.count (indexCount) -- buildPlantGeometry always sets a trivial sequential
  // index, matching grass.js/forest-gpu.js's indexed-geometry convention here.
  const indirectAttrs = palette.variants.map(g => new IndirectStorageBufferAttribute(new Uint32Array([g.index.count, 0, 0, 0, 0]), 5));
  const indirectNodes = indirectAttrs.map(a => storage(a, 'uint', 5));

  const uCam = uniform(new THREE.Vector2());
  const uCullRadius = uniform(opts.cullRadius ?? 45);
  // Edge fade band: from cullStart to cullRadius, survival is a stochastic (dithered)
  // thin-out rather than a hard on/off cutoff -- same technique grass-compute.js uses
  // (see its anchorCull/proceduralCull kernels' `keepRand.greaterThan(edge)` gate), so
  // plants stop popping in/out at a fixed ring the way trees/plants used to and instead
  // thin out gradually, matching how grass approaches its own draw distance.
  const uCullStart = uniform(opts.cullStart ?? (opts.cullRadius ?? 45) * 0.7);

  const reset = Fn(() => { atomicStore(survAtomics.element(instanceIndex), uint(0)); })().compute(V);

  const cull = Fn(() => {
    const idx = int(instanceIndex);
    const cap = int(CAP);
    const localSlot = modInt(idx, cap);
    const g = idx.sub(localSlot).div(cap);
    If(localSlot.lessThan(int(srcCounts.element(g))), () => {
      const rec0 = src.element(idx.mul(uint(2)));
      const rec1 = src.element(idx.mul(uint(2)).add(uint(1)));
      const dist = length(vec2(rec0.x.sub(uCam.x), rec0.z.sub(uCam.y)));
      const gradRange = uCullRadius.sub(uCullStart).max(float(0.001));
      const edge = clamp(dist.sub(uCullStart).div(gradRange), 0, 1);
      const keepRand = posRandFn(rec0.x, rec0.z, int(7));
      const live = dist.lessThan(uCullRadius).and(keepRand.greaterThan(edge));
      If(live, () => {
        const s = atomicAdd(survAtomics.element(uint(g)), uint(1));
        const outBase = uint(g).mul(uint(CAP)).add(s).mul(uint(2));
        draw.element(outBase).assign(rec0);
        draw.element(outBase.add(uint(1))).assign(rec1);
      });
    });
  })().compute(V * CAP);

  const finalizers = [];
  for (let g = 0; g < V; g++) {
    const node = indirectNodes[g];
    finalizers.push(Fn(() => { node.element(1).assign(atomicLoad(survAtomics.element(uint(g)))); })().compute(1));
  }

  function instanceNodes(g) {
    const recBase = uint(g).mul(uint(CAP)).add(instanceIndex).mul(uint(2));
    const rec0 = draw.element(recBase);
    const rec1 = draw.element(recBase.add(uint(1)));
    const scale = rec0.w, yaw = rec1.x;
    const cy = cos(yaw), sy = sin(yaw);
    const px = positionLocal.x, py = positionLocal.y, pz = positionLocal.z;
    const rx = px.mul(cy).add(pz.mul(sy));
    const rz = pz.mul(cy).sub(px.mul(sy));
    const world = vec3(rec0.x.add(rx.mul(scale)), rec0.y.add(py.mul(scale)), rec0.z.add(rz.mul(scale)));
    const nx = normalLocal.x, ny = normalLocal.y, nz = normalLocal.z;
    const nWorld = vec3(nx.mul(cy).add(nz.mul(sy)), ny, nz.mul(cy).sub(nx.mul(sy)));
    return { world, nWorld };
  }

  const meshes = [];
  for (let g = 0; g < V; g++) {
    const mat = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 1.0, metalness: 0.0, side: THREE.DoubleSide });
    const n = instanceNodes(g);
    mat.positionNode = n.world;
    mat.normalNode = n.nWorld;
    const geom = palette.variants[g].clone();
    geom.instanceCount = CAP;
    geom.indirect = indirectAttrs[g];
    const mesh = new THREE.Mesh(geom, mat);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    meshes.push(mesh);
  }

  // ---- CPU: per-chunk placement records -> global source buffer ----
  const chunkRecords = new Map();
  const srcArray = srcAttr.array;
  const countsArray = countsAttr.array;
  let cpuInstances = 0;
  let dirty = true, lastCamX = NaN, lastCamZ = NaN;

  // deterministic variant pick within a species (0 .. variantsPerSpecies-1) -- same formula
  // forest-gpu.js uses, so repeated `slot` values pick the same variant consistently.
  function variantSel(slot) {
    return (Math.imul(slot + 1, 2654435761) >>> 0) % palette.variantsPerSpecies;
  }

  function rebuild() {
    countsArray.fill(0);
    srcArray.fill(0);
    let total = 0;
    // Sort all pooled instances by true distance to the camera before allocating each
    // variant's CAP slots. chunkRecords is a Map, and Map iteration order is insertion
    // order -- re-setChunk()ing an existing key does NOT move it, and newly-entered
    // (nearest) chunks are appended LAST. Filling slots in Map order therefore gives
    // stale/far chunks priority over whatever the player just walked next to, which is
    // backwards. Sorting by actual instance position here removes any dependency on
    // chunk registration order.
    const camX = camera.position.x, camZ = camera.position.z;
    const allRecords = [];
    for (const records of chunkRecords.values()) for (const r of records) allRecords.push(r);
    allRecords.sort((a, b) => {
      const da = (a.x - camX) ** 2 + (a.z - camZ) ** 2;
      const db = (b.x - camX) ** 2 + (b.z - camZ) ** 2;
      return da - db;
    });
    for (const r of allRecords) {
      const g = r.speciesIdx * palette.variantsPerSpecies + variantSel(r.slot);
      if (g < 0 || g >= V) continue;
      const slot = countsArray[g];
      if (slot >= CAP) continue;   // variant window full; drop extras (same policy as forest-gpu.js)
      countsArray[g] = slot + 1;
      const base = (g * CAP + slot) * 8;
      srcArray[base] = r.x; srcArray[base + 1] = heightAt(r.x, r.z); srcArray[base + 2] = r.z; srcArray[base + 3] = r.scale;
      srcArray[base + 4] = r.yaw;
      total++;
    }
    cpuInstances = total;
    srcAttr.needsUpdate = true;
    countsAttr.needsUpdate = true;
    dirty = true;
  }

  return {
    meshes,
    setChunk(key, records) { chunkRecords.set(key, records); rebuild(); },
    clearChunk(key) { if (chunkRecords.delete(key)) rebuild(); },
    setCullRadius(r) { if (uCullRadius.value !== r) { uCullRadius.value = r; dirty = true; } },
    setCullStart(r) { if (uCullStart.value !== r) { uCullStart.value = r; dirty = true; } },
    async update() {
      const camX = camera.position.x, camZ = camera.position.z;
      if (!dirty && camX === lastCamX && camZ === lastCamZ) return;
      uCam.value.set(camX, camZ);
      await renderer.computeAsync([reset, cull, ...finalizers]);
      lastCamX = camX; lastCamZ = camZ; dirty = false;
    },
    get stats() { return { draws: V, instances: cpuInstances, variants: V }; },
    dispose() {
      const mats = new Set();
      meshes.forEach(m => { m.geometry.dispose(); mats.add(m.material); });
      mats.forEach(m => m.dispose());
    },
  };
}
