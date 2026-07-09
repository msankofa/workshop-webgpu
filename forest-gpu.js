// forest-gpu.js — GPU-instanced forest (SP6 gpu path). Mirrors the grass-compute.js
// spine (reset -> cull -> finalize -> indirect draw) but, unlike grass, placement is
// CPU-side: createForestPalette bakes V variant geometries once, CPU placementRecords
// fill a GPU-resident SOURCE buffer (uploaded only on chunk change), and the per-frame
// compute pass only CULLS (camera distance + frustum/cone + far cutoff, transcribing
// forest-cull.js) and COMPACTS survivors per variant into a DRAW buffer that backs
// per-variant indirect draws.
//
// Layout: one global source/draw buffer of V*CAP instances; variant g owns slots
// [g*CAP, (g+1)*CAP). Each instance is 2x vec4: rec0=(x,y,z,scale), rec1=(yaw,_,_,_).
// V = palette.variants.length; each variant draws 3 mesh types (branches/leaves/shadow)
// that share the variant's survivor list (same trees), so cull runs once per variant
// region and finalize writes that variant's survivor count into its 3 indirect buffers.
//
// Milestones 1-4 (docs/superpowers/specs/2026-07-08-trees-performance-design.md): frustum/cone
// rejection + a hard far draw-distance cutoff run in the SAME cull pass, before LOD bucketing
// and before any atomicAdd — a rejected instance never claims a compact slot in any LOD region.
// The classification math (radial LOD bucketing untouched; cone + far-cutoff new) is hand-synced
// with forest-cull.js's classifyInstance()/shouldRecull() — that file is the Node-testable CPU
// twin (same convention as dressing-cull.js/dressing-gpu.js) and is deliberately NOT imported
// here (forest-gpu.js has never imported forest-cull.js) — keep the two files' math in sync
// manually when this kernel changes.
import * as THREE from 'three';
import {
  MeshBasicNodeMaterial, MeshStandardNodeMaterial, StorageInstancedBufferAttribute, StorageBufferAttribute,
  IndirectStorageBufferAttribute,
} from 'three/webgpu';
import {
  Fn, If, instanceIndex, storage, uniform, int, uint, float,
  vec2, vec3, vec4, cos, sin, atan, acos, clamp, length, modInt, positionLocal, normalLocal,
  atomicAdd, atomicStore, atomicLoad,
  normalize, cross, cameraPosition, texture,
} from 'three/tsl';

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
    const mkBill = () => new IndirectStorageBufferAttribute(new Uint32Array([6, 0, 0, 0, 0]), 5);
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
  // Milestone 3: hard far cutoff. Beyond this, instances are rejected outright instead of
  // falling through to an ever-growing LOD3 billboard population (finding 2/design section 2).
  // Default ~1.5x the LOD2/billboard radius (opts.lodR2, viewer default 583 -> 875), giving
  // billboards a bounded visible band past LOD2 rather than "billboard forever".
  const uMaxDrawRadius = uniform(opts.maxDrawRadius ?? (uLodR2.value * 1.5));
  // Milestone 2: camera forward (XZ, normalized) + view-cone cosine, shared by every variant's
  // cull kernel (one camera, one frame) -- same uniform shape as dressing-gpu.js's P4/Milestone 5
  // cone rejection. uConeMargin is WIDER than dressing's 0.35 default: trees are large, so
  // canopy clipping at the padded cone edge is very visible; be conservative. uRearMargin is a
  // small extra cosine tolerance folded into the same unified coneCos threshold (see
  // forest-cull.js's classifyInstance for the exact math this kernel transcribes).
  // uTreeRadius is a single conservative canopy half-width (world units, at instance scale=1)
  // taken as the MAX across every variant's baked bounding box (see variantCanopyRadius below) --
  // one flat constant rather than a per-variant array, so the cone padding is generous everywhere
  // (the biggest tree in the palette sets the margin for all of them).
  const uCamFwd = uniform(new THREE.Vector2(0, -1));
  const uFovCos = uniform(1);
  const uConeMargin = uniform(opts.coneMargin ?? 0.5);
  const uRearMargin = uniform(0.1);
  const uConeEnabled = uniform(1);
  function variantCanopyRadius(variant) {
    if (!variant.branches.boundingBox) variant.branches.computeBoundingBox();
    if (!variant.leaves.boundingBox) variant.leaves.computeBoundingBox();
    const box = new THREE.Box3().copy(variant.branches.boundingBox).union(variant.leaves.boundingBox);
    const size = new THREE.Vector3();
    box.getSize(size);
    return Math.max(size.x, size.z) * 0.5 * 1.15; // half-width, same 1.15 pad as variantBillboardGeo
  }
  const uTreeRadius = uniform(Math.max(0, ...palette.variants.map(variantCanopyRadius)));

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
      const dist = length(vec2(dx, dz));

      // ---- Milestone 3: hard far cutoff (before LOD/cone work) ----
      const farLive = dist.lessThanEqual(uMaxDrawRadius);

      // ---- Milestone 2: behind-camera / outside-padded-cone rejection ----
      // Same math as forest-cull.js's classifyInstance() cone branch: normalize the
      // camera->instance XZ vector, dot with camera forward, compare against a padded cosine
      // threshold that widens both by a flat uConeMargin AND by this instance's own angular
      // canopy radius (uTreeRadius*scale / dist, via atan) -- large nearby trees get more
      // padding than small distant ones. dist<1e-6 guard mirrors the CPU twin (never reject an
      // instance sitting on the camera). uConeEnabled is a 0/1 float flag for backward compat.
      const invDist = float(1.0).div(dist.max(float(1e-6)));
      const nx = dx.mul(invDist);
      const nz = dz.mul(invDist);
      const fwdDot = nx.mul(uCamFwd.x).add(nz.mul(uCamFwd.y));
      const treeRadius = uTreeRadius.mul(rec0.w);
      const angularPad = atan(treeRadius, dist.max(float(1e-6)));
      const baseCos = clamp(uFovCos.sub(uConeMargin), -1, 1);
      const coneCos = cos(acos(baseCos).add(angularPad)).sub(uRearMargin);
      const coneLive = fwdDot.greaterThanEqual(coneCos).or(dist.lessThan(float(1e-6))).or(uConeEnabled.lessThan(float(0.5)));

      const live = farLive.and(coneLive);

      If(live, () => {
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
  // Camera-facing billboard node: ignores instance yaw, aligns plane to always face camera.
  // Uses cylindrical alignment (right = cross(worldUp, camDir), up = worldY) so trees stay upright.
  function instanceNodesBillboard(offset) {
    const recBase = uint(offset).add(instanceIndex).mul(uint(2));
    const rec0 = draw.element(recBase);
    const scale = rec0.w;
    const ipos = vec3(rec0.x, rec0.y, rec0.z);
    const worldUp = vec3(0, 1, 0);
    const camDir = normalize(ipos.sub(cameraPosition));
    const right = normalize(cross(worldUp, camDir));
    const world = ipos
      .add(right.mul(positionLocal.x.mul(scale)))
      .add(worldUp.mul(positionLocal.y.mul(scale)));
    return { world };
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

  function buildBillboardGeo(width, height, centerY) {
    const g = new THREE.PlaneGeometry(width, height);
    g.translate(0, centerY, 0);
    return g;
  }
  function variantBillboardGeo(variant) {
    if (!variant.branches.boundingBox) variant.branches.computeBoundingBox();
    if (!variant.leaves.boundingBox) variant.leaves.computeBoundingBox();
    const box = new THREE.Box3().copy(variant.branches.boundingBox).union(variant.leaves.boundingBox);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    return buildBillboardGeo(Math.max(size.x, size.z) * 1.15, size.y * 1.05, center.y);
  }

  const uBillBrightness = uniform(1.0);
  const branchMats = [], leafMats = [], coarseLeafMats = [], billboardMats = [], meshes = [];
  for (let g = 0; g < V; g++) {
    const variant = palette.variants[g];
    const n0 = instanceNodes(lodSlotOffset(g, 0));
    const n1 = instanceNodes(lodSlotOffset(g, 1));
    const n2 = instanceNodes(lodSlotOffset(g, 2));
    const n3 = instanceNodesBillboard(lodSlotOffset(g, 3));

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
  let needsRebuild = false;   // chunk mutations set this; rebuild() runs once at update() top
  let visibleVariants = 0;    // variants with >0 source records this rebuild
  let submittedDraws = 0;     // meshes actually left visible (visibleVariants * 8)
  let lastCamX = NaN;
  let lastCamZ = NaN;
  let lastCamFx = NaN;
  let lastCamFz = NaN;
  let reculls = 0;
  let skippedReculls = 0;
  // Milestone 4: threshold-gated recull tuning (replaces the old EPS movement check; see the
  // coupling warning below and forest-cull.js's shouldRecull). perfAB sliders can retune both
  // live; changing either does NOT itself force a recull (they only change the gate for FUTURE
  // frames), matching dressing-gpu.js's equivalent sliders.
  let recullMoveDist = 1.5;                          // world units of XZ camera travel
  let recullHeadingCos = Math.cos(2 * Math.PI / 180); // 2 degrees of heading change
  const _fwd3 = new THREE.Vector3();
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
    // NOTE: srcArray is intentionally NOT zeroed. The cull kernel only reads slots where
    // localSlot < srcCounts[g] (== countsArray[g]); every slot beyond a variant's live
    // count is never sampled, so stale data past the count can't leak into a draw. Skipping
    // the full V*CAP*8 fill(0) (~196k floats at cap 2048) removes it from the hot rebuild path.
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
    // Zero-instance visibility gating: a variant with no source records anywhere in the
    // active window submits 8 always-on indirect draws it doesn't need (frustumCulled=false
    // + instanceCount pinned to CAP means Three never drops them). Hide all 8 of the
    // variant's meshes so Three's render list skips them entirely. The compute cull/finalize
    // passes run unconditionally off storage buffers (unaware of mesh.visible), so a hidden
    // variant's indirect buffer is still kept live and correct — flipping .visible back on
    // when it repopulates shows current data immediately. See docs/subsystems/vegetation.md.
    let visCount = 0;
    for (let g = 0; g < V; g++) {
      const vis = countsArray[g] > 0;
      if (vis) visCount++;
      const b = g * 8;
      for (let m = 0; m < 8; m++) meshes[b + m].visible = vis;
    }
    visibleVariants = visCount;
    submittedDraws = visCount * 8;
    if (dropped > 0 && !overflowWarned) {
      overflowWarned = true;
      console.warn(`[forest-gpu] dropped ${dropped} instances this rebuild: a variant exceeded capPerVariant=${CAP}. Raise capPerVariant.`);
    }
    srcAttr.needsUpdate = true;
    countsAttr.needsUpdate = true;
    markDirty();
  }

  // Milestone 1/4 telemetry: lazy CPU-estimate of the cull kernel's per-instance classification
  // (rejected-by-frustum, rejected-by-far-cutoff, and per-LOD survivor counts), computed ONLY
  // when something reads `stats` (e.g. the perf CSV sampler), not every update() call -- same
  // "don't add a per-frame GPU readback, estimate lazily instead" approach dressing-gpu.js took
  // for stats.rejectedFrustum in e1a3ff8. Scans the live srcArray/countsArray (the CPU's own
  // record of what's currently in the window) against the camera pose AS OF THE LAST EXECUTED
  // RECULL (lastCamX/Z/Fx/Fz), so it reflects "as of the most recent recull", not necessarily
  // the exact current camera pose if called between updates -- reimplements the same cone/far
  // math inline in plain JS (not a call into forest-cull.js) for the same no-cross-import reason
  // forest-gpu.js has never imported forest-cull.js.
  function computeCullEstimate() {
    const out = {
      rejectedFrustum: 0, rejectedFar: 0,
      lod0: 0, lod1: 0, lod2: 0, billboard: 0,
    };
    if (!Number.isFinite(lastCamX) || !Number.isFinite(lastCamZ)) return out;
    const coneEnabled = uConeEnabled.value >= 0.5;
    const r0 = uLodR0.value, r1 = uLodR1.value, r2 = uLodR2.value, maxR = uMaxDrawRadius.value;
    for (let g = 0; g < V; g++) {
      const count = countsArray[g];
      for (let slot = 0; slot < count; slot++) {
        const base = (g * CAP + slot) * 8;
        const x = srcArray[base], z = srcArray[base + 2], scale = srcArray[base + 3];
        const dx = x - lastCamX, dz = z - lastCamZ;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist > maxR) { out.rejectedFar++; continue; }
        if (coneEnabled && dist >= 1e-6) {
          const nx = dx / dist, nz = dz / dist;
          const fwdDot = nx * lastCamFx + nz * lastCamFz;
          const treeRadius = uTreeRadius.value * scale;
          const angularPad = Math.atan2(treeRadius, Math.max(dist, 1e-6));
          const baseCos = Math.max(-1, Math.min(1, uFovCos.value - uConeMargin.value));
          const coneCos = Math.cos(Math.acos(baseCos) + angularPad) - uRearMargin.value;
          if (fwdDot < coneCos) { out.rejectedFrustum++; continue; }
        }
        if (dist <= r0) out.lod0++;
        else if (dist <= r1) out.lod1++;
        else if (dist <= r2) out.lod2++;
        else out.billboard++;
      }
    }
    return out;
  }

  // ---- Milestone 5: perf A/B controls (window.perfAB) ----
  // Registered here (inside createForestGPU, called once per host construction, same pattern
  // dressing-gpu.js uses) rather than from environment-viewer.html. No-op outside the viewer
  // (window.perfAB is only installed there; guarded so this stays Node-test-safe where `window`
  // doesn't exist).
  globalThis.window?.perfAB?.addToggle('Forest frustum cull', true, (v) => {
    uConeEnabled.value = v ? 1 : 0;
    markDirty();
  });
  globalThis.window?.perfAB?.addSlider('Forest cone margin', uConeMargin.value, 0, 0.5, 0.01, (v) => {
    uConeMargin.value = v;
    markDirty();
  });
  globalThis.window?.perfAB?.addSlider('Tree max draw radius', uMaxDrawRadius.value, uLodR2.value, uLodR2.value * 3, 5, (v) => {
    uMaxDrawRadius.value = v;
    markDirty();
  });
  globalThis.window?.perfAB?.addSlider('Recull cell size', recullMoveDist, 0.1, 5, 0.1, (v) => {
    recullMoveDist = v;
  });
  globalThis.window?.perfAB?.addSlider('Recull angle deg', 2, 0.5, 15, 0.5, (v) => {
    recullHeadingCos = Math.cos(v * Math.PI / 180);
  });

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
    applyBillboardMap(g, tex) {
      const t = texture(tex);
      billboardMats[g].colorNode = vec4(t.rgb.mul(uBillBrightness), t.a);
      billboardMats[g].needsUpdate = true;
    },
    setBillboardBrightness(val) { uBillBrightness.value = val; },
    _palette: palette,
    // Chunk mutations only flag a pending rebuild; the actual rebuild() (full-window rescan
    // + buffer refill + visibility gating) runs at most once per frame from update()'s top,
    // debouncing the churn when many setChunk/clearChunk calls land in one frame's batch.
    setChunk(key, records) { chunkRecords.set(key, records); needsRebuild = true; },
    setChunks(map) { for (const [k, v] of map) chunkRecords.set(k, v); needsRebuild = true; },
    clearChunk(key) { if (chunkRecords.delete(key)) needsRebuild = true; },
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
    //
    // Milestone 4: threshold-gated recull (replaces the old EPS=0.001 camera-epsilon check,
    // which reculled essentially every walking frame). Recull only when the camera has moved
    // past recullMoveDist, turned past the heading threshold, or `dirty` was set by a data
    // change (chunk mutation, LOD/far-radius change, perfAB cone toggle/margin) -- those always
    // fire immediately, no threshold. Hand-synced with forest-cull.js's shouldRecull (same
    // not-imported twin convention as the cull kernel above).
    //
    // COUPLING WARNING: recullMoveDist/recullHeadingCos are coupled to the cone padding
    // (uConeMargin + uTreeRadius). The padded cone must comfortably cover the worst-case
    // staleness between reculls -- up to recullMoveDist of travel + the heading threshold's
    // turn + the instance's own canopy radius -- so large canopies never pop inside the visible
    // frustum before the next recull fires. Do NOT shrink the cone margin without tightening
    // these thresholds, and vice versa.
    async update() {
      // Run any deferred rebuild before the cull reads the source buffer/counts. rebuild()
      // markDirty()s, so the threshold skip below won't stale a fresh chunk batch.
      if (needsRebuild) { rebuild(); needsRebuild = false; }
      const camX = camera.position.x;
      const camZ = camera.position.z;
      camera.getWorldDirection(_fwd3);
      const fLenSq = _fwd3.x * _fwd3.x + _fwd3.z * _fwd3.z;
      let camFx = uCamFwd.value.x, camFz = uCamFwd.value.y;
      if (fLenSq > 1e-8) {
        const fLen = Math.sqrt(fLenSq);
        camFx = _fwd3.x / fLen; camFz = _fwd3.z / fLen;
      }
      const camFovCos = camera.isPerspectiveCamera
        ? Math.cos((camera.fov * Math.PI / 180) / 2)
        : uFovCos.value;
      const camMoved = (camX - lastCamX) ** 2 + (camZ - lastCamZ) ** 2
        > recullMoveDist * recullMoveDist;
      const camTurned = camFx * lastCamFx + camFz * lastCamFz < recullHeadingCos;
      const firstRecull = !Number.isFinite(lastCamX) || !Number.isFinite(lastCamZ)
        || !Number.isFinite(lastCamFx) || !Number.isFinite(lastCamFz);
      if (!dirty && !firstRecull && !camMoved && !camTurned) {
        skippedReculls++;
        return;
      }
      uCam.value.set(camX, camZ);
      uCamFwd.value.set(camFx, camFz);
      uFovCos.value = camFovCos;
      await renderer.computeAsync([reset, cull, ...finalizersA, ...finalizersB]);
      lastCamX = camX;
      lastCamZ = camZ;
      lastCamFx = camFx;
      lastCamFz = camFz;
      dirty = false;
      reculls++;
    },
    // Milestone 4/perfAB: live-retune the recull thresholds. Does not itself force a recull
    // (only changes the gate future update() calls use) -- same "sliders don't force work"
    // behavior as dressing-gpu.js's cone-margin slider.
    setRecullThresholds(moveDist, headingDeg) {
      if (Number.isFinite(moveDist)) recullMoveDist = moveDist;
      if (Number.isFinite(headingDeg)) recullHeadingCos = Math.cos(headingDeg * Math.PI / 180);
    },
    setMaxDrawRadius(r) {
      if (uMaxDrawRadius.value !== r) { uMaxDrawRadius.value = r; markDirty(); }
    },
    setConeEnabled(v) {
      const nv = v ? 1 : 0;
      if (uConeEnabled.value !== nv) { uConeEnabled.value = nv; markDirty(); }
    },
    setConeMargin(v) {
      if (uConeMargin.value !== v) { uConeMargin.value = v; markDirty(); }
    },
    // draws is the number of meshes actually submitted (visible variants * 8), not the fixed
    // V*8. visibleVariants exposes how many of the V variants survived the zero-instance gate;
    // variants is still the total variant count for reference. rejectedFrustum/rejectedFar/
    // lod0-2/billboard instance counts are lazy CPU estimates (see computeCullEstimate above) —
    // only computed when `stats` is actually read.
    get stats() {
      const est = computeCullEstimate();
      return {
        draws: submittedDraws, visibleVariants, instances: cpuInstances, variants: V,
        reculls, skippedReculls, dirty, cullDispatchInstances: SRC_TOTAL,
        rejectedFrustum: est.rejectedFrustum, rejectedFar: est.rejectedFar,
        lod0Instances: est.lod0, lod1Instances: est.lod1, lod2Instances: est.lod2,
        billboardInstances: est.billboard,
      };
    },
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
