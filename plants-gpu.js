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
  Fn, If, instanceIndex, storage, uniform, int, uint,
  vec3, cos, sin, modInt, positionLocal, normalLocal,
  atomicAdd, atomicStore, atomicLoad,
} from 'three/tsl';

// opts: { renderer, camera, palette (from plants.js's createPlantPalette), heightAt,
//         capPerVariant, cullRadius }
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

  const reset = Fn(() => { atomicStore(survAtomics.element(instanceIndex), uint(0)); })().compute(V);

  const cull = Fn(() => {
    const idx = int(instanceIndex);
    const cap = int(CAP);
    const localSlot = modInt(idx, cap);
    const g = idx.sub(localSlot).div(cap);
    If(localSlot.lessThan(int(srcCounts.element(g))), () => {
      const rec0 = src.element(idx.mul(uint(2)));
      const rec1 = src.element(idx.mul(uint(2)).add(uint(1)));
      const dx = rec0.x.sub(uCam.x);
      const dz = rec0.z.sub(uCam.y);
      const dist2 = dx.mul(dx).add(dz.mul(dz));
      If(dist2.lessThanEqual(uCullRadius.mul(uCullRadius)), () => {
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
    for (const records of chunkRecords.values()) {
      for (const r of records) {
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
