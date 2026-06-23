// forest-gpu.js — GPU-instanced forest (SP6 gpu path). Mirrors the grass-compute.js
// spine (reset -> cull -> finalize -> indirect draw) but, unlike grass, placement is
// CPU-side: createForestPalette bakes V variant geometries once, CPU placementRecords
// fill a GPU-resident SOURCE buffer (uploaded only on chunk change), and the per-frame
// compute pass only CULLS (camera distance, transcribing forest-cull.js) and COMPACTS
// survivors per variant into a DRAW buffer that backs per-variant indirect draws.
//
// Layout: one global source/draw buffer of V*CAP instances; variant g owns slots
// [g*CAP, (g+1)*CAP). Each instance is 2x vec4: rec0=(x,y,z,scale), rec1=(yaw,_,_,_).
// V = palette.variants.length; each variant draws 3 mesh types (branches/leaves/shadow)
// that share the variant's survivor list (same trees), so cull runs once per variant
// region and finalize writes that variant's survivor count into its 3 indirect buffers.
import * as THREE from 'three';
import {
  MeshStandardNodeMaterial, StorageInstancedBufferAttribute, StorageBufferAttribute,
  IndirectStorageBufferAttribute,
} from 'three/webgpu';
import {
  Fn, If, instanceIndex, storage, uniform, int, uint, float,
  vec2, vec3, vec4, cos, sin, modInt, positionLocal, normalLocal,
  atomicAdd, atomicStore, atomicLoad,
} from 'three/tsl';

export function createForestGPU(opts) {
  const { renderer, camera, palette } = opts;
  const heightAt = opts.heightAt || (() => 0);
  const treeBaseOffset = opts.treeBaseOffset ?? 0;
  const variantsPerSpecies = palette.variantsPerSpecies;
  const CAP = opts.capPerVariant ?? 512;          // max live instances per variant in the window
  const maxDist = opts.maxDist ?? 350;
  const V = palette.variants.length;
  const TOTAL = V * CAP;

  // ---- GPU buffers ----
  // source (CPU-filled on chunk change): V*CAP instances x 2 vec4
  const srcAttr = new StorageInstancedBufferAttribute(new Float32Array(TOTAL * 8), 8);
  const src = storage(srcAttr, 'vec4', TOTAL * 2);
  // draw (compute-written survivors; backs the instanced draws)
  const drawAttr = new StorageInstancedBufferAttribute(new Float32Array(TOTAL * 8), 8);
  const draw = storage(drawAttr, 'vec4', TOTAL * 2);
  // per-variant live source count (CPU-uploaded), and per-variant survivor counter (atomic)
  const countsAttr = new StorageBufferAttribute(new Uint32Array(V), 1);
  const srcCounts = storage(countsAttr, 'uint', V);
  const survCounters = storage(new StorageBufferAttribute(new Uint32Array(V), 1), 'uint', V).toAtomic();

  // one indirect buffer per variant per mesh-type; element(1) = instanceCount (survivors).
  const indirectAttrs = [];     // [g] = { branches, leaves, shadow } IndirectStorageBufferAttribute
  const indirectNodes = [];     // [g] = { branches, leaves, shadow } storage nodes
  for (let g = 0; g < V; g++) {
    const variant = palette.variants[g];
    const mk = (geo) => new IndirectStorageBufferAttribute(new Uint32Array([geo.index.count, 0, 0, 0, 0]), 5);
    const a = { branches: mk(variant.branches), leaves: mk(variant.leaves), shadow: mk(variant.shadow) };
    indirectAttrs.push(a);
    indirectNodes.push({
      branches: storage(a.branches, 'uint', 5),
      leaves: storage(a.leaves, 'uint', 5),
      shadow: storage(a.shadow, 'uint', 5),
    });
  }

  // ---- uniforms ----
  const uCam = uniform(new THREE.Vector2());
  const uMaxDist = uniform(maxDist);

  // ---- compute kernels: reset (clear V counters) -> cull+compact -> finalize ----
  const reset = Fn(() => { atomicStore(survCounters.element(instanceIndex), uint(0)); })().compute(V);

  const cull = Fn(() => {
    const idx = int(instanceIndex);                 // 0 .. V*CAP-1
    const cap = int(CAP);
    const localSlot = modInt(idx, cap);
    const g = idx.sub(localSlot).div(cap);          // integer div by exact multiple (grass pattern)
    If(localSlot.lessThan(int(srcCounts.element(g))), () => {
      const rec0 = src.element(idx.mul(uint(2)));   // (x,y,z,scale)
      const dx = rec0.x.sub(uCam.x);
      const dz = rec0.z.sub(uCam.y);
      If(dx.mul(dx).add(dz.mul(dz)).lessThanEqual(uMaxDist.mul(uMaxDist)), () => {
        const s = atomicAdd(survCounters.element(g), uint(1));   // survivor index within variant g
        const outBase = uint(g.mul(cap)).add(s).mul(uint(2));    // global draw slot for variant g
        draw.element(outBase).assign(rec0);
        draw.element(outBase.add(uint(1))).assign(src.element(idx.mul(uint(2)).add(uint(1))));
      });
    });
  })().compute(TOTAL);

  const finalize = Fn(() => {
    for (let g = 0; g < V; g++) {
      const c = atomicLoad(survCounters.element(g));
      indirectNodes[g].branches.element(1).assign(c);
      indirectNodes[g].leaves.element(1).assign(c);
      indirectNodes[g].shadow.element(1).assign(c);
    }
  })().compute(1);

  // ---- per-variant instanced draw meshes ----
  // positionNode/normalNode read the DRAW buffer at the variant's region and apply
  // per-instance yaw rotation + uniform scale + world translation.
  function buildMesh(g, geom, indirectAttr, materialColorRGB, leaf) {
    const offset = g * CAP;
    const mat = new MeshStandardNodeMaterial({
      vertexColors: true, roughness: leaf ? 1.0 : 0.9, metalness: 0.0,
      side: leaf ? THREE.DoubleSide : THREE.FrontSide,
    });
    const recBase = uint(offset).add(instanceIndex).mul(uint(2));
    const rec0 = draw.element(recBase);                  // (x,y,z,scale)
    const rec1 = draw.element(recBase.add(uint(1)));     // (yaw,...)
    const scale = rec0.w, yaw = rec1.x;
    const cy = cos(yaw), sy = sin(yaw);
    const px = positionLocal.x, py = positionLocal.y, pz = positionLocal.z;
    const rx = px.mul(cy).add(pz.mul(sy));
    const rz = pz.mul(cy).sub(px.mul(sy));
    const world = vec3(
      rec0.x.add(rx.mul(scale)),
      rec0.y.add(py.mul(scale)),
      rec0.z.add(rz.mul(scale)),
    );
    const nx = normalLocal.x, ny = normalLocal.y, nz = normalLocal.z;
    const nWorld = vec3(nx.mul(cy).add(nz.mul(sy)), ny, nz.mul(cy).sub(nx.mul(sy)));
    mat.positionNode = world;
    mat.normalNode = nWorld;
    if (opts.addEmissive) mat.emissiveNode = opts.addEmissive(world, nWorld);

    const g2 = geom.clone();
    g2.instanceCount = CAP;
    g2.indirect = indirectAttr;
    const mesh = new THREE.Mesh(g2, mat);
    mesh.frustumCulled = false;
    mesh.castShadow = !leaf || geom === palette.variants[g].shadow;  // branches + shadow cast
    mesh.receiveShadow = true;
    return mesh;
  }

  const meshes = [];
  for (let g = 0; g < V; g++) {
    const variant = palette.variants[g];
    meshes.push(buildMesh(g, variant.branches, indirectAttrs[g].branches, null, false));
    meshes.push(buildMesh(g, variant.leaves, indirectAttrs[g].leaves, null, true));
    meshes.push(buildMesh(g, variant.shadow, indirectAttrs[g].shadow, null, true));
  }

  // ---- CPU side: per-chunk records -> global source buffer ----
  const chunkRecords = new Map();   // chunkKey -> records[]
  const srcArray = srcAttr.array;
  const countsArray = countsAttr.array;
  let cpuInstances = 0;

  // deterministic variant pick within a species (0 .. variantsPerSpecies-1)
  function variantSel(slot) {
    return (Math.imul(slot + 1, 2654435761) >>> 0) % variantsPerSpecies;
  }

  function rebuild() {
    countsArray.fill(0);
    srcArray.fill(0);
    let total = 0;
    for (const records of chunkRecords.values()) {
      for (const r of records) {
        const g = r.speciesIdx * variantsPerSpecies + variantSel(r.slot);
        if (g < 0 || g >= V) continue;
        const slot = countsArray[g];
        if (slot >= CAP) continue;                        // variant window full; drop extras
        countsArray[g] = slot + 1;
        const base = (g * CAP + slot) * 8;
        const y = heightAt(r.x, r.z) + treeBaseOffset;
        srcArray[base] = r.x; srcArray[base + 1] = y; srcArray[base + 2] = r.z; srcArray[base + 3] = r.scale;
        srcArray[base + 4] = r.yaw; srcArray[base + 5] = 0; srcArray[base + 6] = 0; srcArray[base + 7] = 0;
        total++;
      }
    }
    cpuInstances = total;
    srcAttr.needsUpdate = true;
    countsAttr.needsUpdate = true;
  }

  return {
    meshes,
    setChunk(key, records) { chunkRecords.set(key, records); rebuild(); },
    clearChunk(key) { if (chunkRecords.delete(key)) rebuild(); },
    setMaxDist(d) { uMaxDist.value = d; },
    // Awaited so the reset->cull->finalize chain is submitted before the draw reads the
    // indirect instanceCount (unawaited races the draw; see grass-compute.js).
    async update() {
      uCam.value.set(camera.position.x, camera.position.z);
      await renderer.computeAsync(reset);
      await renderer.computeAsync(cull);
      await renderer.computeAsync(finalize);
    },
    get stats() { return { draws: V * 3, instances: cpuInstances, variants: V }; },
    dispose() { meshes.forEach(m => { m.geometry.dispose(); m.material.dispose(); }); },
  };
}
