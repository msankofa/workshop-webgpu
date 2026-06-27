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
  MeshBasicNodeMaterial, MeshStandardNodeMaterial, StorageInstancedBufferAttribute, StorageBufferAttribute,
  IndirectStorageBufferAttribute,
} from 'three/webgpu';
import {
  Fn, If, instanceIndex, storage, uniform, int, uint, float,
  vec2, vec3, vec4, cos, sin, modInt, positionLocal, normalLocal,
  atomicAdd, atomicStore, atomicLoad,
} from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export function createForestGPU(opts) {
  const { renderer, camera, palette } = opts;
  const heightAt = opts.heightAt || (() => 0);
  const treeBaseOffset = opts.treeBaseOffset ?? 0;
  const variantsPerSpecies = palette.variantsPerSpecies;
  const CAP = opts.capPerVariant ?? 512;          // max live instances per variant in the window
  const V = palette.variants.length;
  const LODS = 4;
  const SRC_TOTAL = V * CAP;
  const DRAW_TOTAL = V * LODS * CAP;

  // ---- GPU buffers ----
  // source (CPU-filled on chunk change): V*CAP instances x 2 vec4
  const srcAttr = new StorageInstancedBufferAttribute(new Float32Array(SRC_TOTAL * 8), 8);
  const src = storage(srcAttr, 'vec4', SRC_TOTAL * 2);
  // draw (compute-written survivors; backs the instanced draws): V variants x 4 LOD regions.
  const drawAttr = new StorageInstancedBufferAttribute(new Float32Array(DRAW_TOTAL * 8), 8);
  const draw = storage(drawAttr, 'vec4', DRAW_TOTAL * 2);
  // per-variant live source count (CPU-uploaded), and Vx4 survivor counters (atomic)
  const countsAttr = new StorageBufferAttribute(new Uint32Array(V), 1);
  const srcCounts = storage(countsAttr, 'uint', V);
  const survAtomics = storage(new StorageBufferAttribute(new Uint32Array(V * LODS), 1), 'uint', V * LODS).toAtomic();

  // Eight indirect buffers per variant; element(1) = instanceCount (survivors).
  const indirectAttrs = [];
  const indirectNodes = [];
  for (let g = 0; g < V; g++) {
    const v = palette.variants[g];
    const mk = (geo) => new IndirectStorageBufferAttribute(new Uint32Array([geo.index.count, 0, 0, 0, 0]), 5);
    const mkBill = () => new IndirectStorageBufferAttribute(new Uint32Array([12, 0, 0, 0, 0]), 5);
    const a = {
      branchesL0: mk(v.branches),
      leavesL0: mk(v.leaves),
      shadowL0: mk(v.shadow),
      branchesL1: mk(v.branches),
      leavesL1: mk(v.leaves),
      branchesL2: mk(v.branches),
      coarseLeavesL2: mk(v.leavesCoarse),
      billboardL3: mkBill(),
    };
    indirectAttrs.push(a);
    const sn = (attr) => storage(attr, 'uint', 5);
    indirectNodes.push({
      branchesL0: sn(a.branchesL0),
      leavesL0: sn(a.leavesL0),
      shadowL0: sn(a.shadowL0),
      branchesL1: sn(a.branchesL1),
      leavesL1: sn(a.leavesL1),
      branchesL2: sn(a.branchesL2),
      coarseLeavesL2: sn(a.coarseLeavesL2),
      billboardL3: sn(a.billboardL3),
    });
  }

  // ---- uniforms ----
  const uCam = uniform(new THREE.Vector2());
  const uLodR0 = uniform(opts.lodR0 ?? 60);
  const uLodR1 = uniform(opts.lodR1 ?? 120);
  const uLodR2 = uniform(opts.lodR2 ?? 220);

  // ---- compute kernels: reset (clear V counters) -> cull+compact -> finalize ----
  const reset = Fn(() => { atomicStore(survAtomics.element(instanceIndex), uint(0)); })().compute(V * LODS);

  const cull = Fn(() => {
    const idx = int(instanceIndex);                 // 0 .. V*CAP-1
    const cap = int(CAP);
    const localSlot = modInt(idx, cap);
    const g = idx.sub(localSlot).div(cap);          // integer div by exact multiple (grass pattern)
    If(localSlot.lessThan(int(srcCounts.element(g))), () => {
      const rec0 = src.element(idx.mul(uint(2)));   // (x,y,z,scale)
      const rec1 = src.element(idx.mul(uint(2)).add(uint(1)));
      const dx = rec0.x.sub(uCam.x);
      const dz = rec0.z.sub(uCam.y);
      const dist2 = dx.mul(dx).add(dz.mul(dz));
      const r0sq = uLodR0.mul(uLodR0);
      const r1sq = uLodR1.mul(uLodR1);
      const r2sq = uLodR2.mul(uLodR2);
      const lodCap = int(LODS * CAP);
      const varBase = g.mul(lodCap);

      If(dist2.lessThanEqual(r0sq), () => {
        const ci = uint(g.mul(int(LODS)));
        const s = atomicAdd(survAtomics.element(ci), uint(1));
        const outBase = uint(varBase).add(s).mul(uint(2));
        draw.element(outBase).assign(rec0);
        draw.element(outBase.add(uint(1))).assign(rec1);
      }).ElseIf(dist2.lessThanEqual(r1sq), () => {
        const ci = uint(g.mul(int(LODS)).add(int(1)));
        const s = atomicAdd(survAtomics.element(ci), uint(1));
        const outBase = uint(varBase.add(int(CAP))).add(s).mul(uint(2));
        draw.element(outBase).assign(rec0);
        draw.element(outBase.add(uint(1))).assign(rec1);
      }).ElseIf(dist2.lessThanEqual(r2sq), () => {
        const ci = uint(g.mul(int(LODS)).add(int(2)));
        const s = atomicAdd(survAtomics.element(ci), uint(1));
        const outBase = uint(varBase.add(int(2 * CAP))).add(s).mul(uint(2));
        draw.element(outBase).assign(rec0);
        draw.element(outBase.add(uint(1))).assign(rec1);
      }).Else(() => {
        const ci = uint(g.mul(int(LODS)).add(int(3)));
        const s = atomicAdd(survAtomics.element(ci), uint(1));
        const outBase = uint(varBase.add(int(3 * CAP))).add(s).mul(uint(2));
        draw.element(outBase).assign(rec0);
        draw.element(outBase.add(uint(1))).assign(rec1);
      });
    });
  })().compute(SRC_TOTAL);

  // Split finalizers to stay under WebGPU's per-stage storage binding cap.
  const finalizersA = [], finalizersB = [];
  for (let g = 0; g < V; g++) {
    const nodes = indirectNodes[g];
    const c0idx = g * LODS + 0, c1idx = g * LODS + 1;
    const c2idx = g * LODS + 2, c3idx = g * LODS + 3;
    finalizersA.push(Fn(() => {
      const c0 = atomicLoad(survAtomics.element(c0idx));
      const c1 = atomicLoad(survAtomics.element(c1idx));
      nodes.branchesL0.element(1).assign(c0);
      nodes.leavesL0.element(1).assign(c0);
      nodes.shadowL0.element(1).assign(c0);
      nodes.branchesL1.element(1).assign(c1);
      nodes.leavesL1.element(1).assign(c1);
    })().compute(1));
    finalizersB.push(Fn(() => {
      const c2 = atomicLoad(survAtomics.element(c2idx));
      const c3 = atomicLoad(survAtomics.element(c3idx));
      nodes.branchesL2.element(1).assign(c2);
      nodes.coarseLeavesL2.element(1).assign(c2);
      nodes.billboardL3.element(1).assign(c3);
    })().compute(1));
  }

  // ---- per-variant materials + instanced draw meshes ----
  // positionNode/normalNode read the DRAW buffer at the variant's region and apply
  // per-instance yaw rotation + uniform scale + world translation. Each variant gets
  // its OWN materials (the region offset is baked into positionNode); the leaf material
  // is shared between the variant's leaves and shadow meshes (same instances/transform).
  // Texture/colorNode binding is deferred to applyTextureSet() so the viewer drives the
  // same procedural-bark / authored-map logic it uses for the baked path.
  function instanceNodes(offset) {
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
    return { world, nWorld };
  }
  function lodSlotOffset(g, l) {
    return g * LODS * CAP + l * CAP;
  }
  function drawMesh(geom, mat, indirectAttr, castShadow) {
    const g2 = geom.clone();
    g2.instanceCount = CAP;
    g2.indirect = indirectAttr;
    const mesh = new THREE.Mesh(g2, mat);
    mesh.frustumCulled = false;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    return mesh;
  }

  function buildCrossQuadGeo(width, height, centerY) {
    const g1 = new THREE.PlaneGeometry(width, height);
    const g2 = new THREE.PlaneGeometry(width, height);
    g2.rotateY(Math.PI / 2);
    g1.translate(0, centerY, 0);
    g2.translate(0, centerY, 0);
    return mergeGeometries([g1, g2]);
  }
  function variantBillboardGeo(variant) {
    if (!variant.branches.boundingBox) variant.branches.computeBoundingBox();
    if (!variant.leaves.boundingBox) variant.leaves.computeBoundingBox();
    const box = new THREE.Box3().copy(variant.branches.boundingBox).union(variant.leaves.boundingBox);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    return buildCrossQuadGeo(Math.max(size.x, size.z) * 1.15, size.y * 1.05, center.y);
  }

  const branchMats = [], leafMats = [], coarseLeafMats = [], billboardMats = [], meshes = [];
  for (let g = 0; g < V; g++) {
    const variant = palette.variants[g];
    const n0 = instanceNodes(lodSlotOffset(g, 0));
    const n1 = instanceNodes(lodSlotOffset(g, 1));
    const n2 = instanceNodes(lodSlotOffset(g, 2));
    const n3 = instanceNodes(lodSlotOffset(g, 3));

    function makeMat(roughness, doubleSide) {
      return new MeshStandardNodeMaterial({
        vertexColors: true,
        roughness,
        metalness: 0.0,
        side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
      });
    }

    const branchMat = makeMat(0.9, false);
    const leafMat = makeMat(1.0, true);
    const branchMat1 = makeMat(0.9, false);
    const leafMat1 = makeMat(1.0, true);
    const branchMat2 = makeMat(0.9, false);
    const coarseMat = makeMat(1.0, true);
    const billMat = new MeshBasicNodeMaterial({ transparent: true, alphaTest: 0.5, side: THREE.DoubleSide });

    branchMat.positionNode = n0.world; branchMat.normalNode = n0.nWorld;
    leafMat.positionNode = n0.world; leafMat.normalNode = n0.nWorld;
    branchMat1.positionNode = n1.world; branchMat1.normalNode = n1.nWorld;
    leafMat1.positionNode = n1.world; leafMat1.normalNode = n1.nWorld;
    branchMat2.positionNode = n2.world; branchMat2.normalNode = n2.nWorld;
    coarseMat.positionNode = n2.world; coarseMat.normalNode = n2.nWorld;
    billMat.positionNode = n3.world;

    if (opts.addEmissive) {
      for (const m of [branchMat, leafMat, branchMat1, leafMat1, branchMat2, coarseMat]) {
        m.emissiveNode = opts.addEmissive(m.positionNode, m.normalNode);
      }
    }

    branchMats.push({ L0: branchMat, L1: branchMat1, L2: branchMat2 });
    leafMats.push({ L0: leafMat, L1: leafMat1 });
    coarseLeafMats.push(coarseMat);
    billboardMats.push(billMat);

    meshes.push(drawMesh(variant.branches, branchMat, indirectAttrs[g].branchesL0, true));
    meshes.push(drawMesh(variant.leaves, leafMat, indirectAttrs[g].leavesL0, false));
    meshes.push(drawMesh(variant.shadow, leafMat, indirectAttrs[g].shadowL0, true));
    meshes.push(drawMesh(variant.branches, branchMat1, indirectAttrs[g].branchesL1, true));
    meshes.push(drawMesh(variant.leaves, leafMat1, indirectAttrs[g].leavesL1, false));
    meshes.push(drawMesh(variant.branches, branchMat2, indirectAttrs[g].branchesL2, true));
    meshes.push(drawMesh(variant.leavesCoarse, coarseMat, indirectAttrs[g].coarseLeavesL2, false));

    const billGeo = variantBillboardGeo(variant);
    billGeo.instanceCount = CAP;
    billGeo.indirect = indirectAttrs[g].billboardL3;
    const billMesh = new THREE.Mesh(billGeo, billMat);
    billMesh.frustumCulled = false;
    billMesh.castShadow = false;
    billMesh.receiveShadow = true;
    meshes.push(billMesh);
  }

  // ---- CPU side: per-chunk records -> global source buffer ----
  const chunkRecords = new Map();   // chunkKey -> records[]
  const srcArray = srcAttr.array;
  const countsArray = countsAttr.array;
  let cpuInstances = 0;
  let dirty = true;
  let lastCamX = NaN;
  let lastCamZ = NaN;
  let reculls = 0;
  let skippedReculls = 0;
  const EPS = 0.001;
  function markDirty() {
    dirty = true;
  }

  // deterministic variant pick within a species (0 .. variantsPerSpecies-1)
  function variantSel(slot) {
    return (Math.imul(slot + 1, 2654435761) >>> 0) % variantsPerSpecies;
  }

  let overflowWarned = false;
  function rebuild() {
    countsArray.fill(0);
    srcArray.fill(0);
    let total = 0, dropped = 0;
    for (const records of chunkRecords.values()) {
      for (const r of records) {
        const g = r.speciesIdx * variantsPerSpecies + variantSel(r.slot);
        if (g < 0 || g >= V) continue;
        const slot = countsArray[g];
        if (slot >= CAP) { dropped++; continue; }         // variant window full; drop extras
        countsArray[g] = slot + 1;
        const base = (g * CAP + slot) * 8;
        const y = heightAt(r.x, r.z) + treeBaseOffset;
        srcArray[base] = r.x; srcArray[base + 1] = y; srcArray[base + 2] = r.z; srcArray[base + 3] = r.scale;
        srcArray[base + 4] = r.yaw; srcArray[base + 5] = 0; srcArray[base + 6] = 0; srcArray[base + 7] = 0;
        total++;
      }
    }
    cpuInstances = total;
    if (dropped > 0 && !overflowWarned) {
      overflowWarned = true;
      console.warn(`[forest-gpu] dropped ${dropped} instances this rebuild: a variant exceeded capPerVariant=${CAP}. Raise capPerVariant.`);
    }
    srcAttr.needsUpdate = true;
    countsAttr.needsUpdate = true;
    markDirty();
  }

  return {
    meshes,
    // Drive the same material binding the baked path uses: fn(branchMat, leafMat) is
    // called for every variant (procedural bark colorNode, or authored bark/leaf maps).
    applyTextureSet(fn) {
      for (let g = 0; g < V; g++) {
        const bm = branchMats[g], lm = leafMats[g];
        fn(bm.L0, lm.L0);
        fn(bm.L1, lm.L1);
        fn(bm.L2, coarseLeafMats[g]);
      }
    },
    get billboardMaterials() { return billboardMats; },
    _palette: palette,
    setChunk(key, records) { chunkRecords.set(key, records); rebuild(); },
    clearChunk(key) { if (chunkRecords.delete(key)) rebuild(); },
    setLodDistances(r0, r1, r2) {
      let changed = false;
      if (uLodR0.value !== r0) { uLodR0.value = r0; changed = true; }
      if (uLodR1.value !== r1) { uLodR1.value = r1; changed = true; }
      if (uLodR2.value !== r2) { uLodR2.value = r2; changed = true; }
      if (changed) markDirty();
    },
    // Awaited so the reset->cull->finalize chain is submitted before the draw reads the
    // indirect instanceCount (unawaited races the draw; see grass-compute.js). The whole
    // chain goes in ONE computeAsync([...]) submit (three dispatches the array in order on
    // a single encoder): 14 separate awaited submits/frame were the gpu path's CPU cost.
    async update() {
      const camX = camera.position.x;
      const camZ = camera.position.z;
      if (!dirty && Math.abs(camX - lastCamX) <= EPS && Math.abs(camZ - lastCamZ) <= EPS) {
        skippedReculls++;
        return;
      }
      uCam.value.set(camX, camZ);
      await renderer.computeAsync([reset, cull, ...finalizersA, ...finalizersB]);
      lastCamX = camX;
      lastCamZ = camZ;
      dirty = false;
      reculls++;
    },
    get stats() { return { draws: V * 8, instances: cpuInstances, variants: V, reculls, skippedReculls, dirty }; },
    dispose() {
      const mats = new Set();
      meshes.forEach(m => {
        m.geometry.dispose();
        if (Array.isArray(m.material)) m.material.forEach(mat => mats.add(mat));
        else mats.add(m.material);
      });
      mats.forEach(m => m.dispose());
    },
  };
}
