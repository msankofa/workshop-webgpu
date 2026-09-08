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
import { createSharedDrawGeometryPool } from './shared-draw-geometry.js';
// Camera math and the pulled-draw arena packing: both are plain data work with no kernel twin, so
// they are imported. The cull kernel itself stays the hand-synced, not-imported twin.
import {
  frustumConeCos, packPulledArena, pulledArenaSlots, PULLED_VERTEX_STRIDE, PULLED_COMPACT_CHUNK,
} from './forest-cull.js';
import { createHizSampler } from './hiz-test.js';
import {
  MeshBasicNodeMaterial, MeshStandardNodeMaterial, StorageInstancedBufferAttribute, StorageBufferAttribute,
  IndirectStorageBufferAttribute,
} from 'three/webgpu';
import {
  Fn, If, instanceIndex, storage, uniform, int, uint, float,
  vec2, vec3, vec4, cos, sin, atan, acos, clamp, length, modInt, positionLocal, normalLocal,
  atomicAdd, atomicStore, atomicLoad, min, max, dot, dFdx, dFdy, inverseSqrt, varying,
  normalize, cross, cameraPosition, texture, time, userData, vertexIndex, select,
} from 'three/tsl';

// Storage buffers the pulled vertex stage binds: the merged live-instance list, the arena
// vertices, the arena indices, the per-variant counts. test-forest-pulled-wgsl.mjs counts the
// `var<storage>` declarations in the built vertex WGSL and asserts they equal this.
export const PULLED_VERTEX_STORAGE_BINDINGS = 4;
export const pulledStorageBindingsNeeded = () => PULLED_VERTEX_STORAGE_BINDINGS;

// The admission rule for a pulled mode, decided from the DEVICE THREE ACTUALLY CREATED and nothing
// else. A caller-supplied number or a separately requested adapter is diagnostic context, never
// authorization: an adapter can report a limit the device was never granted. Returns
// { admitted, limit, source, reason }.
//
//   device present  -> admitted iff limits.maxStorageBuffersInVertexStage >= 4.
//   no device (Node tests, a renderer built before init) -> UNKNOWN, refused, unless the test
//     option assumeLimits says otherwise: `true` proceeds on the unknown, or an object with a
//     maxStorageBuffersInVertexStage number stands in for a device's limits.
export function pulledAdmission(renderer, assumeLimits) {
  const lim = renderer?.backend?.device?.limits;
  if (lim) {
    const limit = lim.maxStorageBuffersInVertexStage;
    if (!Number.isFinite(limit)) {
      return { admitted: false, limit: null, source: 'device', reason: 'the device does not report maxStorageBuffersInVertexStage' };
    }
    return {
      admitted: limit >= PULLED_VERTEX_STORAGE_BINDINGS, limit, source: 'device',
      reason: limit >= PULLED_VERTEX_STORAGE_BINDINGS ? null
        : `the device admits ${limit} storage buffers in the vertex stage; the pulled draw needs ${PULLED_VERTEX_STORAGE_BINDINGS}`,
    };
  }
  if (assumeLimits && Number.isFinite(assumeLimits.maxStorageBuffersInVertexStage)) {
    const limit = assumeLimits.maxStorageBuffersInVertexStage;
    return {
      admitted: limit >= PULLED_VERTEX_STORAGE_BINDINGS, limit, source: 'assumed',
      reason: limit >= PULLED_VERTEX_STORAGE_BINDINGS ? null
        : `the assumed limit is ${limit} storage buffers in the vertex stage; the pulled draw needs ${PULLED_VERTEX_STORAGE_BINDINGS}`,
    };
  }
  if (assumeLimits === true) return { admitted: true, limit: null, source: 'assumed-unknown', reason: null };
  return {
    admitted: false, limit: null, source: 'unknown',
    reason: 'there is no device to read maxStorageBuffersInVertexStage from; pass assumeLimits to build the pulled path anyway',
  };
}

// What the device will actually admit, when there is a device. Three r184 keeps the WebGPU device
// at renderer.backend.device; adapter limits are the ceiling the page could have requested.
// Returns null before the renderer has initialised, so a caller must treat null as "unknown".
export function deviceLimits(renderer) {
  const backend = renderer?.backend;
  const lim = backend?.device?.limits;
  if (!lim) return null;
  const adapter = backend?.adapter?.limits ?? null;
  return {
    compatibilityMode: !!backend.compatibilityMode,
    maxStorageBuffersInVertexStage: lim.maxStorageBuffersInVertexStage,
    maxStorageBuffersPerShaderStage: lim.maxStorageBuffersPerShaderStage,
    maxStorageBufferBindingSize: lim.maxStorageBufferBindingSize,
    maxBufferSize: lim.maxBufferSize,
    maxSampledTexturesPerShaderStage: lim.maxSampledTexturesPerShaderStage,
    // Context only. The adapter says what COULD have been requested; nothing is admitted on it.
    adapter: adapter ? {
      maxStorageBuffersInVertexStage: adapter.maxStorageBuffersInVertexStage,
      maxStorageBuffersPerShaderStage: adapter.maxStorageBuffersPerShaderStage,
      maxStorageBufferBindingSize: adapter.maxStorageBufferBindingSize,
    } : null,
    pulledVertexBindingsNeeded: PULLED_VERTEX_STORAGE_BINDINGS,
    pulledAdmitted: Number.isFinite(lim.maxStorageBuffersInVertexStage)
      ? lim.maxStorageBuffersInVertexStage >= PULLED_VERTEX_STORAGE_BINDINGS : null,
  };
}

export function createForestGPU(opts) {
  const { renderer, camera, palette } = opts;
  const heightAt = opts.heightAt || (() => 0);
  let treeBaseOffset = opts.treeBaseOffset ?? 0;
  const variantsPerSpecies = palette.variantsPerSpecies;
  const CAP = opts.capPerVariant ?? 512;          // max live instances per variant in the window
  const V = palette.variants.length;
  // The environment viewer uses the donor's billboard rung. Base Game ends at LOD2, so constructing
  // that fourth region would allocate, finalize and precompile resources which can never draw.
  const HAS_BILLBOARDS = opts.billboards !== false;
  const LODS = HAS_BILLBOARDS ? 4 : 3;
  // Shadow list (Base Game): a host that names a layer gets one extra region per variant holding
  // every instance within uShadowReach, cone or not, drawn by two shadow-only meshes on that layer.
  const SHADOW_LAYER = Number.isInteger(opts.shadowLayer) ? opts.shadowLayer : null;
  const SHADOW_LIST = SHADOW_LAYER !== null;
  const SHADOW_SLOT = LODS;
  const SLOTS = LODS + (SHADOW_LIST ? 1 : 0);
  const SRC_TOTAL = V * CAP;
  const DRAW_TOTAL = V * SLOTS * CAP;

  // ---- GPU buffers ----
  // source (CPU-filled on chunk change): V*CAP instances x 2 vec4
  const srcAttr = new StorageInstancedBufferAttribute(new Float32Array(SRC_TOTAL * 8), 8);
  const src = storage(srcAttr, 'vec4', SRC_TOTAL * 2);
  // draw (compute-written survivors; backs the instanced draws): V variants x active LOD regions.
  const drawAttr = new StorageInstancedBufferAttribute(new Float32Array(DRAW_TOTAL * 8), 8);
  const draw = storage(drawAttr, 'vec4', DRAW_TOTAL * 2);
  // per-variant live source count (CPU-uploaded), and VxLODS survivor counters (atomic)
  const countsAttr = new StorageBufferAttribute(new Uint32Array(V), 1);
  const srcCounts = storage(countsAttr, 'uint', V);
  const survAttr = new StorageBufferAttribute(new Uint32Array(V * SLOTS), 1);
  const survAtomics = storage(survAttr, 'uint', V * SLOTS).toAtomic();

  // Seven indirect buffers per variant, plus the optional billboard; element(1) is instanceCount.
  const indirectAttrs = [];
  const indirectNodes = [];
  for (let g = 0; g < V; g++) {
    const v = palette.variants[g];
    const branchesL1Geo = v.branchesLod1 ?? v.branches;
    const branchesL2Geo = v.branchesLod2 ?? v.branches;
    const mk = (geo) => new IndirectStorageBufferAttribute(new Uint32Array([geo.index.count, 0, 0, 0, 0]), 5);
    const mkBill = () => new IndirectStorageBufferAttribute(new Uint32Array([6, 0, 0, 0, 0]), 5);
    const a = {
      branchesL0: mk(v.branches),
      leavesL0: mk(v.leaves),
      shadowL0: mk(v.shadow),
      branchesL1: mk(branchesL1Geo),
      leavesL1: mk(v.leaves),
      branchesL2: mk(branchesL2Geo),
      coarseLeavesL2: mk(v.leavesCoarse),
    };
    if (HAS_BILLBOARDS) a.billboardL3 = mkBill();
    if (SHADOW_LIST) { a.barkShadow = mk(v.branches); a.leafShadow = mk(v.shadow); }
    indirectAttrs.push(a);
    const sn = (attr) => storage(attr, 'uint', 5);
    const nodes = {
      branchesL0: sn(a.branchesL0),
      leavesL0: sn(a.leavesL0),
      shadowL0: sn(a.shadowL0),
      branchesL1: sn(a.branchesL1),
      leavesL1: sn(a.leavesL1),
      branchesL2: sn(a.branchesL2),
      coarseLeavesL2: sn(a.coarseLeavesL2),
    };
    if (HAS_BILLBOARDS) nodes.billboardL3 = sn(a.billboardL3);
    if (SHADOW_LIST) { nodes.barkShadow = sn(a.barkShadow); nodes.leafShadow = sn(a.leafShadow); }
    indirectNodes.push(nodes);
  }

  // ---- pulled draw mode (prototype, one role: branchesL2) ----
  // 'variants' (default) is the shipped path: one mesh per (variant, role). 'pulled' replaces the
  // V branchesL2 meshes with ONE instanced indexed draw whose vertex stage reads its geometry from
  // a storage arena, so every variant fits in a single draw. Everything else — the cull, the other
  // roles, the shadow list, the rung gate — is untouched, and the per-variant L2 meshes are still
  // built so a failed arena can fall back to them without a rebuild.
  // Two pulled mappings share the arena and differ only in how a vertex invocation finds its
  // (variant, instance, k):
  //   'pulled'         SLOTS   — uniform per-variant slots. instanceCount = live instances,
  //                              indexCount = the padded slot, so a small variant pays the biggest
  //                              variant's index count on every instance.
  //   'pulled-compact' COMPACT — a per-variant live-count prefix table written by the finalizer on
  //                              the GPU, and one flat vertex stream cut into fixed chunks, so the
  //                              draw dispatches sum(live[v]*indexCount[v]) plus a chunk tail.
  // One enum rather than a second orthogonal `pulledMapping` option: a mapping only means anything
  // when a pulled mode is on, and the page already has one select for this rung.
  const PULLED_SLOTS = opts.drawMode === 'pulled';
  const PULLED_COMPACT = opts.drawMode === 'pulled-compact';
  const PULLED = PULLED_SLOTS || PULLED_COMPACT;
  const MERGED_TOTAL = V * CAP;             // one flat live list for the merged role
  const COMPACT_CHUNK = Math.max(3, Math.round((opts.pulledChunk ?? PULLED_COMPACT_CHUNK) / 3) * 3);
  const l2GeometryFor = v => (v?.branchesLod2 ?? v?.branches ?? null);
  let arena = null, arenaSlots = null, arenaOk = false, arenaFailure = null;
  // The vertex stage cannot run at all if the device will not bind its storage buffers, so the
  // limit is read from the device Three created, before anything is packed. Anything short of it
  // (including "there is no device to ask") falls the mode back to 'variants'.
  const admission = PULLED ? pulledAdmission(opts.renderer, opts.assumeLimits) : null;
  let arenaVertAttr = null, arenaIdxAttr = null, arenaCountAttr = null;
  let arenaVerts = null, arenaIdx = null, arenaCounts = null, arenaCountsRW = null;
  let mergedAttr = null, mergedDraw = null, mergedCountAttr = null, mergedAtomic = null;
  let mergedIndirect = null, mergedIndirectNode = null;
  // Where the GPU-written prefix table lives inside the counts buffer. Keeping it in the SAME
  // buffer as the per-variant counts is what holds the compact vertex stage at four storage
  // bindings — a fifth buffer would need a limit the slot path does not.
  const PREFIX_BASE = V * 2;
  if (PULLED && !admission.admitted) {
    arenaFailure = admission.reason;
    console.warn(`[forest-gpu] ${arenaFailure}. Falling back to one draw per variant.`);
  } else if (PULLED) {
    const geos = palette.variants.map(l2GeometryFor);
    // Slots are uniform and sized with headroom, because a progressive wave installs a REAL
    // geometry over a placeholder and it may be larger than anything in the first wave. The
    // headroom is paid for on EVERY instance of EVERY variant: the merged draw dispatches
    // indexSlot vertex invocations per instance whatever the variant's real index count is, so
    // slack 2 measured 4.39x the invocations of a compact mapping on the default palette against
    // 2.19x at slack 1 (scratchpads/fps-churn/pulled-slot-cost.mjs). Placeholders are variant 0 of
    // the same species, so 1.25 covers seed-to-seed variation; a variant that still overflows
    // falls back to its own mesh through repackArenaVariant.
    const tight = pulledArenaSlots(geos);
    arenaSlots = {
      vertexSlot: Math.max(1, Math.ceil(tight.vertexSlot * (opts.pulledSlack ?? 1.25))),
      indexSlot: Math.max(3, Math.ceil(tight.indexSlot * (opts.pulledSlack ?? 1.25))),
    };
    arena = packPulledArena(geos, arenaSlots);
    if (!arena) {
      arenaFailure = 'the branchesL2 palette does not fit its arena slots';
    } else {
      arenaOk = true;
      // vec4 triples: (px,py,pz,u) (nx,ny,nz,v) (r,g,b,_). One indexed read per triple.
      arenaVertAttr = new StorageBufferAttribute(arena.vertexData, 4);
      arenaIdxAttr = new StorageBufferAttribute(arena.indexData, 1);
      // Counts, then (compact only) V+1 exclusive prefix boundaries the finalizer writes each frame.
      const countsLen = arena.counts.length + (PULLED_COMPACT ? V + 1 : 0);
      const countsData = new Uint32Array(countsLen);
      countsData.set(arena.counts);
      arena.counts = countsData;           // repackArenaVariant keeps writing [g*2], [g*2+1]
      arenaCountAttr = new StorageBufferAttribute(countsData, 1);
      arenaVerts = storage(arenaVertAttr, 'vec4', arena.vertexData.length / 4).toReadOnly();
      arenaIdx = storage(arenaIdxAttr, 'uint', arena.indexData.length).toReadOnly();
      arenaCounts = storage(arenaCountAttr, 'uint', countsLen).toReadOnly();
      // The same buffer, writable, for the compact finalizer's prefix pass. Read-only in the vertex
      // stage and read_write in a compute pass is one buffer with one STORAGE usage either way.
      if (PULLED_COMPACT) arenaCountsRW = storage(arenaCountAttr, 'uint', countsLen);
      if (PULLED_SLOTS) {
        // The merged live list: the same 2 x vec4 record the per-variant lists hold, with the
        // variant id parked in rec1.y (a spare field, already zero) so the vertex stage can find
        // its arena slot without a second buffer read. The compact mapping needs none of this: it
        // reads the per-variant L2 region of the existing draw buffer and the counters already there.
        mergedAttr = new StorageInstancedBufferAttribute(new Float32Array(MERGED_TOTAL * 8), 8);
        mergedDraw = storage(mergedAttr, 'vec4', MERGED_TOTAL * 2);
        mergedCountAttr = new StorageBufferAttribute(new Uint32Array(1), 1);
        mergedAtomic = storage(mergedCountAttr, 'uint', 1).toAtomic();
      }
      // A normal 5-uint indexed-indirect buffer, exactly as every other role uses. indexCount is
      // the padded stride (slots) or the fixed chunk (compact); instanceCount is written by the
      // merged finalizer.
      mergedIndirect = new IndirectStorageBufferAttribute(
        new Uint32Array([PULLED_COMPACT ? COMPACT_CHUNK : arenaSlots.indexSlot, 0, 0, 0, 0]), 5);
      mergedIndirectNode = storage(mergedIndirect, 'uint', 5);
    }
  }

  // ---- uniforms ----
  const uCam = uniform(new THREE.Vector2());
  const uLodR0 = uniform(opts.lodR0 ?? 60);
  const uLodR1 = uniform(opts.lodR1 ?? 120);
  const uLodR2 = uniform(opts.lodR2 ?? 220);
  const uTreeScale = uniform(1);
  const uLeafScale = uniform(1);
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
  const uShadowReach = uniform(0);   // metres; 0 = the shadow list is empty
  function variantCanopyRadius(variant) {
    if (!variant.branches.boundingBox) variant.branches.computeBoundingBox();
    if (!variant.leaves.boundingBox) variant.leaves.computeBoundingBox();
    const box = new THREE.Box3().copy(variant.branches.boundingBox).union(variant.leaves.boundingBox);
    const size = new THREE.Vector3();
    box.getSize(size);
    return Math.max(size.x, size.z) * 0.5 * 1.15; // half-width, same 1.15 pad as variantBillboardGeo
  }
  const uTreeRadius = uniform(Math.max(0, ...palette.variants.map(variantCanopyRadius)));
  function variantHeight(variant) {
    if (!variant.branches.boundingBox) variant.branches.computeBoundingBox();
    if (!variant.leaves.boundingBox) variant.leaves.computeBoundingBox();
    return Math.max(variant.branches.boundingBox.max.y, variant.leaves.boundingBox.max.y, 0);
  }
  const uTreeHeight = uniform(Math.max(0, ...palette.variants.map(variantHeight)));
  // Hi-Z (2026-09-06): a host with a hiz-pyramid.js state gets hiz-test.js's box test in the cull.
  const hizSampler = opts.hiz ? createHizSampler(opts.hiz) : null;
  // The pyramid changes every frame; the forest re-tests against it every `hizRecullFrames`
  // frames unless the camera thresholds below fire first (tiered recull plan, step 4).
  let hizRecullFrames = Math.max(1, Math.round(opts.hizRecullFrames ?? 4));
  let hizFramesSince = 0;

  // Canopy sway (base-game). The graph is only built when a host asks for it, so a host that does
  // not pass leafSway keeps the time-independent material it had.
  const swayEnabled = opts.leafSway !== undefined;
  const uLeafSway = uniform(opts.leafSway ?? 0);
  // Base Game's render origin. Records arrive GLOBAL and the buffer holds render-local, so a
  // rebase moves where a tree draws without touching which trees exist.
  let originX = 0, originY = 0, originZ = 0;

  // ---- compute kernels: reset (clear V counters) -> cull+compact -> finalize ----
  const reset = Fn(() => { atomicStore(survAtomics.element(instanceIndex), uint(0)); })().compute(V * SLOTS);
  // The merged counter is its own one-invocation reset rather than a branch inside the one above:
  // a kernel the shipped path never dispatches is easier to reason about than a widened dispatch.
  const resetMerged = arenaOk && PULLED_SLOTS
    ? Fn(() => { atomicStore(mergedAtomic.element(0), uint(0)); })().compute(1)
    : null;
  // Slots: the merged compaction counter becomes instanceCount directly.
  // Compact: one invocation walks the V variants in order, writing the exclusive prefix of
  // live[v]*indexCount[v] into the counts buffer and the chunk count into the indirect buffer. V is
  // known at build time, so the walk is unrolled here rather than looped in WGSL. live is clamped to
  // CAP, the same clamp the per-variant indirect draws carry, so a variant whose cull overflowed its
  // slot cannot claim vertices the draw buffer does not hold. A variant that fell back to its own
  // mesh has indexCount 0 here, which makes its span empty.
  const finalizeMerged = !arenaOk ? null : PULLED_SLOTS
    ? Fn(() => {
      const live = atomicLoad(mergedAtomic.element(0));
      mergedIndirectNode.element(1).assign(min(live, uint(MERGED_TOTAL)));
    })().compute(1)
    : Fn(() => {
      const total = uint(0).toVar();
      for (let g = 0; g < V; g++) {
        arenaCountsRW.element(uint(PREFIX_BASE + g)).assign(total);
        const c = min(atomicLoad(survAtomics.element(g * SLOTS + 2)), uint(CAP));
        const ic = arenaCountsRW.element(uint(g * 2 + 1));
        total.addAssign(c.mul(ic));
      }
      arenaCountsRW.element(uint(PREFIX_BASE + V)).assign(total);
      mergedIndirectNode.element(1).assign(total.add(uint(COMPACT_CHUNK - 1)).div(uint(COMPACT_CHUNK)));
    })().compute(1);

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

      if (SHADOW_LIST) {
        // Casters are everything within reach, behind the camera included: a tree beside you
        // casts across your feet. The cone below is for what the eye sees, not the light.
        If(dist2.lessThanEqual(uShadowReach.mul(uShadowReach)).and(uShadowReach.greaterThan(float(0))), () => {
          const ci = uint(g.mul(int(SLOTS)).add(int(SHADOW_SLOT)));
          const s = atomicAdd(survAtomics.element(ci), uint(1));
          const outBase = uint(g.mul(int(SLOTS * CAP)).add(int(SHADOW_SLOT * CAP))).add(s).mul(uint(2));
          draw.element(outBase).assign(rec0);
          draw.element(outBase.add(uint(1))).assign(rec1);
        });
      }

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
      const treeRadius = uTreeRadius.mul(rec0.w).mul(uTreeScale);
      const angularPad = atan(treeRadius, dist.max(float(1e-6)));
      const baseCos = clamp(uFovCos.sub(uConeMargin), -1, 1);
      const coneCos = cos(acos(baseCos).add(angularPad)).sub(uRearMargin);
      const coneLive = fwdDot.greaterThanEqual(coneCos).or(dist.lessThan(float(1e-6))).or(uConeEnabled.lessThan(float(0.5)));

      // Hi-Z: the instance's box (canopy radius wide, tree height tall) against last frame's depth
      // pyramid. The shadow slot above is written before this on purpose: a hidden tree still casts.
      let live = farLive.and(coneLive);
      if (hizSampler) {
        const hr = uTreeRadius.mul(rec0.w).mul(uTreeScale), th = uTreeHeight.mul(rec0.w).mul(uTreeScale);
        const hidden = hizSampler.occluded(vec3(rec0.x.sub(hr), rec0.y, rec0.z.sub(hr)), vec3(rec0.x.add(hr), rec0.y.add(th), rec0.z.add(hr)));
        live = live.and(hidden.not());
      }

      If(live, () => {
        const r0sq = uLodR0.mul(uLodR0);
        const r1sq = uLodR1.mul(uLodR1);
        const r2sq = uLodR2.mul(uLodR2);
        const lodCap = int(SLOTS * CAP);
        const varBase = g.mul(lodCap);

        const lodChain = If(dist2.lessThanEqual(r0sq), () => {
          const ci = uint(g.mul(int(SLOTS)));
          const s = atomicAdd(survAtomics.element(ci), uint(1));
          const outBase = uint(varBase).add(s).mul(uint(2));
          draw.element(outBase).assign(rec0);
          draw.element(outBase.add(uint(1))).assign(rec1);
        }).ElseIf(dist2.lessThanEqual(r1sq), () => {
          const ci = uint(g.mul(int(SLOTS)).add(int(1)));
          const s = atomicAdd(survAtomics.element(ci), uint(1));
          const outBase = uint(varBase.add(int(CAP))).add(s).mul(uint(2));
          draw.element(outBase).assign(rec0);
          draw.element(outBase.add(uint(1))).assign(rec1);
        }).ElseIf(dist2.lessThanEqual(r2sq), () => {
          const ci = uint(g.mul(int(SLOTS)).add(int(2)));
          const s = atomicAdd(survAtomics.element(ci), uint(1));
          const outBase = uint(varBase.add(int(2 * CAP))).add(s).mul(uint(2));
          draw.element(outBase).assign(rec0);
          draw.element(outBase.add(uint(1))).assign(rec1);
          if (arenaOk && PULLED_SLOTS) {
            // The merged list for the pulled draw: one flat, cross-variant compaction of the same
            // survivors, with the variant id carried in rec1.y. The per-variant write above is
            // deliberately kept so 'variants' mode is bit-identical and a fallback needs no rebuild.
            const ms = atomicAdd(mergedAtomic.element(0), uint(1));
            If(ms.lessThan(uint(MERGED_TOTAL)), () => {
              const mBase = ms.mul(uint(2));
              mergedDraw.element(mBase).assign(rec0);
              mergedDraw.element(mBase.add(uint(1))).assign(vec4(rec1.x, float(g), rec1.z, rec1.w));
            });
          }
        });
        if (HAS_BILLBOARDS) lodChain.Else(() => {
          const ci = uint(g.mul(int(SLOTS)).add(int(3)));
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
    const c0idx = g * SLOTS + 0, c1idx = g * SLOTS + 1;
    const c2idx = g * SLOTS + 2;
    const csidx = g * SLOTS + SHADOW_SLOT;
    finalizersA.push(Fn(() => {
      const c0 = atomicLoad(survAtomics.element(c0idx));
      const c1 = atomicLoad(survAtomics.element(c1idx));
      nodes.branchesL0.element(1).assign(c0);
      nodes.leavesL0.element(1).assign(c0);
      nodes.shadowL0.element(1).assign(c0);
      nodes.branchesL1.element(1).assign(c1);
      nodes.leavesL1.element(1).assign(c1);
    })().compute(1));
    if (HAS_BILLBOARDS) {
      const c3idx = g * SLOTS + 3;
      finalizersB.push(Fn(() => {
        const c2 = atomicLoad(survAtomics.element(c2idx));
        const c3 = atomicLoad(survAtomics.element(c3idx));
        nodes.branchesL2.element(1).assign(c2);
        nodes.coarseLeavesL2.element(1).assign(c2);
        nodes.billboardL3.element(1).assign(c3);
        if (SHADOW_LIST) {
          const cs = atomicLoad(survAtomics.element(csidx));
          nodes.barkShadow.element(1).assign(cs);
          nodes.leafShadow.element(1).assign(cs);
        }
      })().compute(1));
    } else {
      finalizersB.push(Fn(() => {
        const c2 = atomicLoad(survAtomics.element(c2idx));
        nodes.branchesL2.element(1).assign(c2);
        nodes.coarseLeavesL2.element(1).assign(c2);
        if (SHADOW_LIST) {
          const cs = atomicLoad(survAtomics.element(csidx));
          nodes.barkShadow.element(1).assign(cs);
          nodes.leafShadow.element(1).assign(cs);
        }
      })().compute(1));
    }
  }

  // ---- per-variant materials + instanced draw meshes ----
  // positionNode/normalNode read the DRAW buffer at the variant's region and apply
  // per-instance yaw rotation + uniform scale + world translation. Each variant gets
  // its OWN materials (the region offset is baked into positionNode); the leaf material
  // is shared between the variant's leaves and shadow meshes (same instances/transform).
  // Texture/colorNode binding is deferred to applyTextureSet() so the viewer drives the
  // same procedural-bark / authored-map logic it uses for the baked path.
  // Sway, scaled by height off the trunk base so the trunk stays planted (bot-trees.js:113-121).
  function swayed(p) {
    const lift = p.y.mul(0.02).mul(uLeafSway);
    return vec3(
      p.x.add(sin(time.mul(1.3).add(p.y.mul(0.35))).mul(lift)),
      p.y,
      p.z.add(sin(time.mul(0.9).add(p.x.mul(0.3))).mul(lift)),
    );
  }
  // The slot offset is read from the MESH being drawn (userData, refreshed per object, depth pass
  // included), so one material per role serves every variant: a per-material constant made ~224
  // WGSL programs for 16 variants, a per-material uniform still made ~256 pipelines.
  function instanceNodes(scaleMultiplier = uTreeScale, sway = false) {
    const recBase = userData('slotOffset', 'uint').add(instanceIndex).mul(uint(2));
    const rec0 = draw.element(recBase);                  // (x,y,z,scale)
    const rec1 = draw.element(recBase.add(uint(1)));     // (yaw,...)
    const scale = rec0.w.mul(scaleMultiplier), yaw = rec1.x;
    const cy = cos(yaw), sy = sin(yaw);
    const local = (sway && swayEnabled) ? swayed(positionLocal) : positionLocal;
    const px = local.x, py = local.y, pz = local.z;
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
  function instanceNodesBillboard() {
    const recBase = userData('slotOffset', 'uint').add(instanceIndex).mul(uint(2));
    const rec0 = draw.element(recBase);
    const scale = rec0.w.mul(uTreeScale);
    const ipos = vec3(rec0.x, rec0.y, rec0.z);
    const worldUp = vec3(0, 1, 0);
    const camDir = normalize(ipos.sub(cameraPosition));
    const right = normalize(cross(worldUp, camDir));
    const world = ipos
      .add(right.mul(positionLocal.x.mul(scale)))
      .add(worldUp.mul(positionLocal.y.mul(scale)));
    return { world };
  }

  // The pulled vertex stage. Transcribes forest-cull.js's pulledVertexOffset: the identity index
  // buffer makes vertexIndex the local index k, rec1.y names the variant, and the arena answers
  // with the vertex that variant's own index buffer points at. k past the variant's index count
  // collapses onto its k=0 vertex, so the padded triangles are zero-area and raster nothing.
  function pulledInstanceNodes() {
    let v, kk, rec0, rec1;
    if (PULLED_COMPACT) {
      // Transcribes forest-cull.js's pulledCompactLookup. The draw is a flat vertex stream cut into
      // COMPACT_CHUNK-sized instances, so the global vertex index is instance*chunk + vertexIndex.
      const gi = uint(instanceIndex).mul(uint(COMPACT_CHUNK)).add(uint(vertexIndex));
      const total = arenaCounts.element(uint(PREFIX_BASE + V));
      const inRange = gi.lessThan(total);
      // Branchless variant search: how many prefix boundaries gi is at or past. V <= 16, so this is
      // 15 comparisons of uniform cost with no divergence, against four dependent branchy steps for
      // a binary search. Equal boundaries (a variant with no live instances) are both counted, so
      // an empty span is stepped straight over.
      // A pure expression tree, not a .toVar() accumulator: these nodes are built outside any Fn().
      let vAcc = uint(0);
      for (let u = 1; u < V; u++) {
        vAcc = vAcc.add(select(gi.greaterThanEqual(arenaCounts.element(uint(PREFIX_BASE + u))), uint(1), uint(0)));
      }
      // Past the total (the tail of the last chunk) every vertex collapses onto variant 0's k=0, so
      // its triangle has no area. The compact mapping cannot address past a variant's own index
      // count, so unlike slots it has no arena overflow to guard.
      v = select(inRange, vAcc, uint(0));
      const r = select(inRange, gi.sub(arenaCounts.element(uint(PREFIX_BASE).add(v))), uint(0));
      const ic = max(arenaCounts.element(v.mul(uint(2)).add(uint(1))), uint(1));
      const inst = r.div(ic);
      kk = r.sub(inst.mul(ic));
      // The compact mapping reads the per-variant L2 region of the shipped draw buffer directly.
      const recBase = uint(v.mul(uint(SLOTS * CAP)).add(uint(2 * CAP)).add(inst)).mul(uint(2));
      rec0 = draw.element(recBase);
      rec1 = draw.element(recBase.add(uint(1)));
    } else {
      const recBase = uint(instanceIndex).mul(uint(2));
      rec0 = mergedDraw.element(recBase);                 // (x,y,z,scale)
      rec1 = mergedDraw.element(recBase.add(uint(1)));    // (yaw, variantId, _, _)
      v = uint(rec1.y);
      const k = uint(vertexIndex);
      const idxCount = arenaCounts.element(v.mul(uint(2)).add(uint(1)));
      kk = select(k.lessThan(idxCount), k, uint(0));
    }
    const local = arenaIdx.element(v.mul(uint(arenaSlots.indexSlot)).add(kk));
    const vBase = v.mul(uint(arenaSlots.vertexSlot)).add(local).mul(uint(3));
    const a0 = arenaVerts.element(vBase);                     // (px,py,pz,u)
    const a1 = arenaVerts.element(vBase.add(uint(1)));        // (nx,ny,nz,v)
    const a2 = arenaVerts.element(vBase.add(uint(2)));        // (r,g,b,_)

    const scale = rec0.w.mul(uTreeScale), yaw = rec1.x;
    const cy = cos(yaw), sy = sin(yaw);
    const px = a0.x, py = a0.y, pz = a0.z;
    const rx = px.mul(cy).add(pz.mul(sy));
    const rz = pz.mul(cy).sub(px.mul(sy));
    const world = vec3(
      rec0.x.add(rx.mul(scale)),
      rec0.y.add(py.mul(scale)),
      rec0.z.add(rz.mul(scale)),
    );
    const nx = a1.x, ny = a1.y, nz = a1.z;
    const nWorld = vec3(nx.mul(cy).add(nz.mul(sy)), ny, nz.mul(cy).sub(nx.mul(sy)));
    // uv, colour and the shading normal cross into the fragment stage as varyings. Without this
    // the arena reads are repeated per FRAGMENT, which binds all four storage buffers in the
    // fragment stage too (measured in test-forest-pulled-wgsl.mjs before the varyings went in).
    const uv = varying(vec2(a0.w, a1.w), 'v_pulledUv');
    const color = varying(a2.xyz, 'v_pulledColor');
    const nVary = varying(nWorld, 'v_pulledNormal');
    const posVary = varying(world, 'v_pulledWorld');

    // Bark normal mapping without a tangent attribute. The tree geometry has none, so three falls
    // back to its derivative frame (three.webgpu.js `tangentViewFrame`, thetenthplanet) built from
    // the `uv` ATTRIBUTE — which on the pulled mesh's dummy geometry is all zeros, giving a
    // degenerate frame. This is that same construction driven by the arena uv instead. The result
    // is an OBJECT-space normal, which is what normalNode wants (transformNormalToView); the mesh
    // sits at the origin with a world-space positionNode, so object space and world space coincide.
    // FrontSide only, so there is no double-sided flip to reinstate.
    // Always the varying, never `nWorld` directly: normalNode is evaluated in the FRAGMENT stage,
    // and the raw node re-ran the whole arena index chase per fragment (and bound all four storage
    // buffers there) -- measured in test-forest-pulled-wgsl.mjs before this.
    function normalFor(normalMap, scale = 1) {
      if (!normalMap) return nVary;
      const N = normalize(nVary);
      const q0 = dFdx(posVary), q1 = dFdy(posVary);
      const st0 = dFdx(uv), st1 = dFdy(uv);
      const q1p = cross(q1, N), q0p = cross(N, q0);
      const T = q1p.mul(st0.x).add(q0p.mul(st1.x));
      const B = q1p.mul(st0.y).add(q0p.mul(st1.y));
      const det = max(dot(T, T), dot(B, B));
      // A zero determinant is a degenerate triangle or a flat uv patch: keep the geometric normal.
      const inv = select(det.greaterThan(float(0)), inverseSqrt(det), float(0));
      const m = texture(normalMap, uv).xyz.mul(2).sub(1);
      const t = m.x.mul(scale), b = m.y.mul(scale);
      const mapped = T.mul(inv).mul(t).add(B.mul(inv).mul(b)).add(N.mul(m.z));
      return select(inv.greaterThan(float(0)), normalize(mapped), N);
    }
    return { world, nWorld, uv, color, normalFor };
  }

  function lodSlotOffset(g, l) {
    return g * SLOTS * CAP + l * CAP;
  }
  const geometryPool = createSharedDrawGeometryPool(renderer);
  const drawableGeometry = (geom, indirectAttr) => geometryPool.acquire(geom, CAP, indirectAttr);
  function drawMesh(geom, mat, indirectAttr, castShadow, slotOffset, name = '') {
    const g2 = drawableGeometry(geom, indirectAttr);
    const mesh = new THREE.Mesh(g2, mat);
    mesh.userData.slotOffset = slotOffset;   // where this variant's records start in the draw buffer
    mesh.name = name;   // so a scene census can attribute the forest's always-on meshes
    mesh.frustumCulled = false;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    return mesh;
  }

  // P5/Milestone 6 (docs/superpowers/specs/2026-07-08-trees-performance-design.md, finding 5):
  // PlaneGeometry's default winding faces +local-Z, matching its baked +Z normal. But
  // instanceNodesBillboard (below) builds world position from `right = cross(worldUp, camDir)`
  // where camDir points FROM the camera TOWARD the instance (i.e. `right` is the basis for a
  // quad whose "front" -- the side visible per its ORIGINAL winding -- ends up facing AWAY from
  // the camera, not toward it: dot(faceNormal, towardCamera) == -1 for every camera position,
  // verified in test-trees-geometry.mjs section "billboard winding"). That is a real winding
  // bug, not a genuine two-sided need (a billboard by construction only ever needs to be seen
  // from the camera side). Reversing each triangle's index order flips the winding so the front
  // face matches instanceNodesBillboard's actual camera-facing orientation, letting `billMat`
  // use FrontSide by default instead of paying DoubleSide's disabled-backface-cull cost on every
  // billboard fragment.
  function buildBillboardGeo(width, height, centerY) {
    const g = new THREE.PlaneGeometry(width, height);
    const idx = g.getIndex();
    const arr = idx.array;
    for (let i = 0; i + 2 < arr.length; i += 3) {
      const b = arr[i + 1];
      arr[i + 1] = arr[i + 2];
      arr[i + 2] = b;
    }
    idx.needsUpdate = true;
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
  const billboardMats = [], meshes = [];
  // P5/Milestone 6: materials whose `.side` the "Tree leaves double-sided" perfAB toggle flips
  // at runtime (L1 leaves, coarse L2 leaves, billboards -- see the comment above where they're
  // created). L0 leaf materials are intentionally excluded; they stay hardcoded DoubleSide.
  const sideSwitchableMats = new Set();

  function makeMat(roughness, doubleSide) {
    return new MeshStandardNodeMaterial({
      vertexColors: true,
      roughness,
      metalness: 0.0,
      side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
    });
  }

  // P5/Milestone 6 (finding 5): leaf cards are genuinely single-sided quads (verified in
  // test-trees-geometry.mjs -- the winding-derived face normal matches the baked vertex
  // normal, so there is no winding bug to fix here) that must be visible from most azimuths
  // in a canopy. `doubleBillboard` (trees.js) adds a SECOND perpendicular card per leaf, but
  // two single-sided perpendicular cards still leave a real ~90 degree viewing wedge where
  // both show their backface (worked example in the design doc's finding-5 follow-up) --
  // duplicating backface geometry to close that gap was evaluated and rejected: LOD0 leaves
  // alone run ~7200 verts/3600 tris per variant, so mirroring every leaf card would double an
  // already-large per-variant vertex budget (CPU generation + GPU memory + vertex-stage work
  // on every instance, including off-screen ones under indirect draw) to save DoubleSide's
  // fragment-stage-only cost -- not a clean trade at this density. Split instead, per the
  // design doc's explicitly named partial-win option: keep DoubleSide for close LOD0 leaves
  // (backface gaps are most visible up close) and default L1/coarse-L2 leaves to FrontSide
  // (farther away, gaps are far less noticeable, and this is also where instance/overdraw
  // count is largest so the fragment-stage win matters most). L0 leaves are intentionally
  // NOT part of the "Tree leaves double-sided" toggle below (same "hardcoded exception,
  // outside the toggle" treatment deadfall.js gives mushroom caps) -- only L1/coarse/billboard
  // materials, which default to the FrontSide/cheap side, are toggle-switchable.
  // One material per role for the whole forest (the slot offset comes from each mesh's userData).
  // Billboards are the exception: each variant has its own baked capture, so its own material.
  const n0 = instanceNodes(uTreeScale), n0Leaf = instanceNodes(uTreeScale.mul(uLeafScale), true);
  const n1 = instanceNodes(uTreeScale), n1Leaf = instanceNodes(uTreeScale.mul(uLeafScale), true);
  const n2 = instanceNodes(uTreeScale), n2Leaf = instanceNodes(uTreeScale.mul(uLeafScale), true);
  const branchMat = makeMat(0.9, false);
  const leafMat = makeMat(1.0, true);
  const branchMat1 = makeMat(0.9, false);
  const leafMat1 = makeMat(1.0, false);
  const branchMat2 = makeMat(0.9, false);
  const coarseMat = makeMat(1.0, false);
  sideSwitchableMats.add(leafMat1);
  sideSwitchableMats.add(coarseMat);
  branchMat.positionNode = n0.world; branchMat.normalNode = n0.nWorld;
  leafMat.positionNode = n0Leaf.world; leafMat.normalNode = n0Leaf.nWorld;
  branchMat1.positionNode = n1.world; branchMat1.normalNode = n1.nWorld;
  leafMat1.positionNode = n1Leaf.world; leafMat1.normalNode = n1Leaf.nWorld;
  branchMat2.positionNode = n2.world; branchMat2.normalNode = n2.nWorld;
  coarseMat.positionNode = n2Leaf.world; coarseMat.normalNode = n2Leaf.nWorld;
  const branchMats = { L0: branchMat, L1: branchMat1, L2: branchMat2 };
  const leafMats = { L0: leafMat, L1: leafMat1 };
  let shadowMats = null;
  if (SHADOW_LIST) {
    // Shadow-only pair: full trunk plus the reduced leaf cards, on the shadow layer so the main
    // camera never sees them. One bark caster replaces the three per-rung ones.
    const nS = instanceNodes(uTreeScale), nSLeaf = instanceNodes(uTreeScale.mul(uLeafScale), true);
    const barkShadowMat = makeMat(0.9, false);
    const leafShadowMat = makeMat(1.0, true);
    barkShadowMat.positionNode = nS.world; barkShadowMat.normalNode = nS.nWorld;
    leafShadowMat.positionNode = nSLeaf.world; leafShadowMat.normalNode = nSLeaf.nWorld;
    shadowMats = { bark: barkShadowMat, leaf: leafShadowMat };
  }
  const sharedMats = [branchMat, leafMat, branchMat1, leafMat1, branchMat2, coarseMat,
    ...(shadowMats ? [shadowMats.bark, shadowMats.leaf] : [])];
  if (opts.addEmissive) {
    for (const m of sharedMats) m.emissiveNode = opts.addEmissive(m.positionNode, m.normalNode);
  }

  for (let g = 0; g < V; g++) {
    const variant = palette.variants[g];
    const branchesL1Geo = variant.branchesLod1 ?? variant.branches;
    const branchesL2Geo = variant.branchesLod2 ?? variant.branches;
    const off = l => lodSlotOffset(g, l);

    meshes.push(drawMesh(variant.branches, branchMat, indirectAttrs[g].branchesL0, true, off(0), `forest:v${g}:branchesL0`));
    meshes.push(drawMesh(variant.leaves, leafMat, indirectAttrs[g].leavesL0, false, off(0), `forest:v${g}:leavesL0`));
    meshes.push(drawMesh(variant.shadow, leafMat, indirectAttrs[g].shadowL0, true, off(0), `forest:v${g}:shadowL0`));
    meshes.push(drawMesh(branchesL1Geo, branchMat1, indirectAttrs[g].branchesL1, true, off(1), `forest:v${g}:branchesL1`));
    meshes.push(drawMesh(variant.leavesMid ?? variant.leaves, leafMat1, indirectAttrs[g].leavesL1, false, off(1), `forest:v${g}:leavesL1`));
    meshes.push(drawMesh(branchesL2Geo, branchMat2, indirectAttrs[g].branchesL2, true, off(2), `forest:v${g}:branchesL2`));
    meshes.push(drawMesh(variant.leavesCoarse, coarseMat, indirectAttrs[g].coarseLeavesL2, false, off(2), `forest:v${g}:coarseLeavesL2`));

    if (HAS_BILLBOARDS) {
      // Billboard winding fixed in buildBillboardGeo (above) so FrontSide is now correct -- see
      // that function's comment. Toggle-switchable alongside leafMat1/coarseMat.
      const billMat = new MeshBasicNodeMaterial({ transparent: true, alphaTest: 0.5, side: THREE.FrontSide });
      billMat.positionNode = instanceNodesBillboard().world;
      sideSwitchableMats.add(billMat);
      billboardMats.push(billMat);
      const billGeo = variantBillboardGeo(variant);
      billGeo.instanceCount = CAP;
      billGeo.indirect = indirectAttrs[g].billboardL3;
      const billMesh = new THREE.Mesh(billGeo, billMat);
      billMesh.userData.slotOffset = off(3);
      billMesh.name = `forest:v${g}:billboard`;
      billMesh.frustumCulled = false;
      billMesh.castShadow = false;
      billMesh.receiveShadow = true;
      meshes.push(billMesh);
    }

    if (SHADOW_LIST) {
      // Bark casts from the L2 trunk geometry: at ~9cm shadow texels the full branches add nothing.
      const barkShadow = drawMesh(branchesL2Geo, shadowMats.bark, indirectAttrs[g].barkShadow, true, off(SHADOW_SLOT), `forest:v${g}:barkShadow`);
      const leafShadow = drawMesh(variant.shadow, shadowMats.leaf, indirectAttrs[g].leafShadow, true, off(SHADOW_SLOT), `forest:v${g}:leafShadow`);
      for (const m of [barkShadow, leafShadow]) { m.layers.set(SHADOW_LAYER); m.receiveShadow = false; }
      meshes.push(barkShadow, leafShadow);
    }
  }

  // The merged branchesL2 draw. Built alongside the per-variant meshes (never instead of them) so
  // switching arms is a visibility flip, and a broken arena falls back without a rebuild.
  let mergedMesh = null, mergedMat = null;
  if (arenaOk) {
    mergedMat = makeMat(0.9, false);
    mergedMat.vertexColors = false;          // colour comes from the arena, not a vertex attribute
    const pn = pulledInstanceNodes();
    mergedMat.positionNode = pn.world;
    mergedMat.normalNode = pn.normalFor(null);
    // The binder (base-game-forest.js's bindTreeMaterials) needs arena uv/colour to rebuild the
    // bark look, because neither attribute('uv') nor attribute('color') means anything here.
    mergedMat.userData.pulledNodes = { uv: pn.uv, color: pn.color, normalFor: pn.normalFor };
    if (opts.addEmissive) mergedMat.emissiveNode = opts.addEmissive(mergedMat.positionNode, mergedMat.normalNode);
    sharedMats.push(mergedMat);

    // Slots dispatch one instance per live tree, each indexSlot vertices wide. Compact dispatches
    // ceil(total/chunk) instances of a fixed chunk over one flat vertex stream.
    const stride = PULLED_COMPACT ? COMPACT_CHUNK : arenaSlots.indexSlot;
    const geo = new THREE.InstancedBufferGeometry();
    // Identity indices: @builtin(vertex_index) under an indexed draw is the index VALUE, so this
    // hands the shader k directly. It also keeps every hardware vertex fetch inside the dummy
    // attributes below, whatever attribute nodes Three's material graph still emits.
    const identity = new Uint32Array(stride);
    for (let i = 0; i < stride; i++) identity[i] = i;
    geo.setIndex(new THREE.BufferAttribute(identity, 1));
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(stride * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(stride * 3), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(stride * 2), 2));
    // The ceiling the indirect instanceCount can reach: every variant full at CAP in compact mode,
    // one instance per live tree in slots mode.
    geo.instanceCount = PULLED_COMPACT
      ? Math.ceil(arenaSlots.indexSlot * V * CAP / COMPACT_CHUNK)
      : MERGED_TOTAL;
    geo.indirect = mergedIndirect;
    mergedMesh = new THREE.Mesh(geo, mergedMat);
    mergedMesh.name = 'forest:pulled:branchesL2';
    mergedMesh.frustumCulled = false;
    mergedMesh.castShadow = false;           // as the per-variant L2 meshes are, under SHADOW_LIST
    mergedMesh.receiveShadow = true;
    mergedMesh.visible = false;              // syncRenderParts decides
    meshes.push(mergedMesh);
  }

  // ---- shader/pipeline validation failure ----
  // Nothing in this module can compile the merged program: r184's backend builds the render
  // pipeline lazily on the first draw, and a WGSL or binding error surfaces there, not here. The
  // sync path (WebGPUBackend.createRenderPipeline -> device.createRenderPipeline) does not throw
  // for a validation error at all — WebGPU reports it asynchronously, as an 'uncapturederror' event
  // on the device, and the pipeline is left invalid so the draw is dropped. So while a pulled mode
  // is active the device is listened to, and the FIRST uncaptured error switches the rung back to
  // the per-variant meshes, which are still built and only hidden. Deliberately unfiltered by
  // message: an error raised by some other subsystem would also disable the prototype, and falling
  // back to the shipped path is the safe direction to be wrong in.
  let pulledActive = arenaOk;
  let pulledDeviceListener = null;
  const pulledDevice = arenaOk ? (opts.renderer?.backend?.device ?? null) : null;
  function disablePulled(reason) {
    if (!pulledActive) return false;
    pulledActive = false;
    arenaFailure = reason;
    console.warn(`[forest-gpu] ${reason}. The LOD2 branch rung falls back to one draw per variant.`);
    if (mergedMesh) mergedMesh.visible = false;
    removePulledListener();
    syncRenderParts();
    return true;
  }
  function removePulledListener() {
    if (pulledDeviceListener && pulledDevice?.removeEventListener) {
      pulledDevice.removeEventListener('uncapturederror', pulledDeviceListener);
    }
    pulledDeviceListener = null;
  }
  if (pulledDevice?.addEventListener) {
    pulledDeviceListener = ev => {
      const msg = ev?.error?.message ?? String(ev?.error ?? 'an unnamed device error');
      disablePulled(`the device reported a validation error while the pulled draw was active: ${msg}`);
    };
    pulledDevice.addEventListener('uncapturederror', pulledDeviceListener);
  }

  // ---- CPU side: per-chunk records -> global source buffer ----
  const chunkRecords = new Map();   // chunkKey -> records[]
  const srcArray = srcAttr.array;
  const countsArray = countsAttr.array;
  let cpuInstances = 0;
  let dirty = true;
  let needsRebuild = false;   // chunk mutations set this; rebuild() runs once at update() top
  let visibleVariants = 0;    // variants with >0 source records this rebuild
  let submittedDraws = 0;     // main-pass meshes actually left visible; shadow passes are separate
  let submittedShadowDraws = 0;
  const variantPopulated = new Uint8Array(V);
  const variantReady = new Uint8Array(V);
  variantReady.fill(opts.progressive ? 0 : 1);
  let readyVariantCount = opts.progressive ? 0 : V;
  const renderParts = {
    bark: true, leaves: true, billboards: HAS_BILLBOARDS,
    barkShadows: true, leafShadows: true,
  };
  // Which LOD rung each variant mesh belongs to, and whether that rung draws.
  // A disabled rung's trees VANISH rather than falling back to the next rung — that is the point:
  // it isolates one rung's raster cost. The cull still runs over the full V*CAP and still writes
  // every rung's indirect count, so this measures raster cost only.
  const MAIN_RUNG = HAS_BILLBOARDS ? [0, 0, 0, 1, 1, 2, 2, 3] : [0, 0, 0, 1, 1, 2, 2];
  const MAIN_MESHES = MAIN_RUNG.length;
  // The shadow-only pair (bark, leaf cards) follows the main meshes; -1 = belongs to no rung.
  const MESH_RUNG = SHADOW_LIST ? [...MAIN_RUNG, -1, -1] : MAIN_RUNG;
  const MESHES_PER_VARIANT = MESH_RUNG.length;
  const lodEnabled = new Array(LODS).fill(true);
  // Which rungs cast. A rung whose near edge is past the shadow camera rasterises into a map it
  // cannot appear in, so the host that owns the shadow camera decides. All true = donor behaviour.
  const shadowRungs = new Array(LODS).fill(true);
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
  let lastHizOn = false;
  let recullHeadingCos = Math.cos(2 * Math.PI / 180); // 2 degrees of heading change
  const _fwd3 = new THREE.Vector3();
  function markDirty() {
    dirty = true;
    rungGateDirty = true;
  }

  // Rung gate: a mesh whose rung can hold no tree of its variant is hidden. Bucketing by ring
  // distance alone (no cone, no occlusion, a margin either side of each ring) is an upper bound on
  // what the kernel keeps, so a hidden mesh never has a live indirect count. Each mesh costs the
  // renderer CPU whether its count is 0 or 500; with 16 variants x 9 meshes most rungs are empty.
  const RUNG_GATE = opts.rungGate !== false;
  const RUNG_EPS = 0.5;   // metres of slack around every ring
  const rungCandidates = new Uint8Array(V * (LODS + 1)).fill(1);   // [g * (LODS+1) + rung], last = shadow
  let rungGateDirty = true;
  let rungMeshesHidden = 0;
  function refreshRungCandidates() {
    rungGateDirty = false;
    if (!RUNG_GATE || !Number.isFinite(lastCamX) || !Number.isFinite(lastCamZ)) { rungCandidates.fill(1); return; }
    rungCandidates.fill(0);
    const r0 = uLodR0.value, r1 = uLodR1.value, r2 = uLodR2.value, maxR = uMaxDrawRadius.value;
    const reach = SHADOW_LIST ? uShadowReach.value : 0;
    const stride = LODS + 1;
    for (let g = 0; g < V; g++) {
      const count = countsArray[g], base0 = g * stride;
      for (let slot = 0; slot < count; slot++) {
        const base = (g * CAP + slot) * 8;
        const dx = srcArray[base] - lastCamX, dz = srcArray[base + 2] - lastCamZ;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist <= r0 + RUNG_EPS) rungCandidates[base0] = 1;
        if (dist >= r0 - RUNG_EPS && dist <= r1 + RUNG_EPS) rungCandidates[base0 + 1] = 1;
        if (dist >= r1 - RUNG_EPS && dist <= r2 + RUNG_EPS) rungCandidates[base0 + 2] = 1;
        if (HAS_BILLBOARDS && dist >= r2 - RUNG_EPS && dist <= maxR + RUNG_EPS) rungCandidates[base0 + 3] = 1;
        if (reach > 0 && dist <= reach + RUNG_EPS) rungCandidates[base0 + LODS] = 1;
      }
    }
  }
  const rungHas = (g, rung) => rungCandidates[g * (LODS + 1) + rung] === 1;

  // Which per-variant mesh index holds the L2 branch role (the pulled prototype's one role).
  const L2_BRANCH_MESH = 5;

  // A progressive wave replaces one variant's placeholder geometry with its real one. Repack that
  // variant's arena slot in place and upload only its range. A geometry too big for the slot is
  // NOT packed: its count stays 0, the merged draw skips it, and its per-variant mesh takes over.
  let arenaOverflows = 0;
  const arenaFallback = new Uint8Array(V);
  function repackArenaVariant(g, variant) {
    const geo = l2GeometryFor(variant);
    const one = packPulledArena([geo], arenaSlots);
    if (!one) {
      arenaOverflows++;
      arenaFallback[g] = 1;
      arena.counts[g * 2] = 0;
      arena.counts[g * 2 + 1] = 0;
      uploadCounts(g);
      console.warn(`[forest-gpu] variant ${g}'s branchesL2 does not fit the pulled arena slot; it falls back to its own mesh.`);
      syncRenderParts();
      return false;
    }
    arenaFallback[g] = 0;
    const vSpan = arenaSlots.vertexSlot * PULLED_VERTEX_STRIDE;
    arena.vertexData.set(one.vertexData, g * vSpan);
    arena.indexData.set(one.indexData, g * arenaSlots.indexSlot);
    arena.counts[g * 2] = one.counts[0];
    arena.counts[g * 2 + 1] = one.counts[1];
    arenaVertAttr.clearUpdateRanges();
    arenaVertAttr.addUpdateRange(g * vSpan, vSpan);
    arenaVertAttr.needsUpdate = true;
    arenaIdxAttr.clearUpdateRanges();
    arenaIdxAttr.addUpdateRange(g * arenaSlots.indexSlot, arenaSlots.indexSlot);
    arenaIdxAttr.needsUpdate = true;
    uploadCounts(g);
    return true;
  }
  // Only this variant's two counts. A full upload would push the CPU array's stale prefix region
  // over the one the finalizer wrote, and a frame whose recull was gated would then draw nothing.
  function uploadCounts(g) {
    arenaCountAttr.clearUpdateRanges();
    arenaCountAttr.addUpdateRange(g * 2, 2);
    arenaCountAttr.needsUpdate = true;
  }
  function syncRenderParts() {
    if (rungGateDirty) refreshRungCandidates();
    let draws = 0, shadowDraws = 0, gated = 0;
    let mergedWanted = false;
    const shadowsOn = SHADOW_LIST && uShadowReach.value > 0;
    for (let g = 0; g < V; g++) {
      const active = variantReady[g] === 1 && variantPopulated[g] === 1;
      const b = g * MESHES_PER_VARIANT;
      const mask = [
        renderParts.bark,
        renderParts.leaves,
        renderParts.leaves,
        renderParts.bark,
        renderParts.leaves,
        renderParts.bark,
        renderParts.leaves,
      ];
      if (HAS_BILLBOARDS) mask.push(renderParts.billboards && renderParts.bark && renderParts.leaves);
      for (let m = 0; m < MAIN_MESHES; m++) {
        const wanted = active && mask[m] && lodEnabled[MAIN_RUNG[m]];
        const has = rungHas(g, MAIN_RUNG[m]);
        // In pulled mode the merged mesh draws this variant's L2 branches instead; the per-variant
        // mesh stays built but hidden, and its "would have drawn" answer feeds the merged gate.
        if (pulledActive && m === L2_BRANCH_MESH && !arenaFallback[g]) {
          if (wanted && has) mergedWanted = true;
          meshes[b + m].visible = false;
          continue;
        }
        meshes[b + m].visible = wanted && has;
        if (meshes[b + m].visible) draws++;
        else if (wanted) gated++;
      }
      if (SHADOW_LIST) {
        // Main meshes never cast; the shadow-only pair carries every caster within reach.
        for (let m = 0; m < MAIN_MESHES; m++) meshes[b + m].castShadow = false;
        const bark = meshes[b + MAIN_MESHES], leaf = meshes[b + MAIN_MESHES + 1];
        const inReach = rungHas(g, LODS);
        const barkWanted = active && shadowsOn && renderParts.barkShadows;
        const leafWanted = active && shadowsOn && renderParts.leafShadows;
        bark.visible = barkWanted && inReach;
        leaf.visible = leafWanted && inReach;
        shadowDraws += (bark.visible ? 1 : 0) + (leaf.visible ? 1 : 0);
        gated += (barkWanted && !inReach ? 1 : 0) + (leafWanted && !inReach ? 1 : 0);
      } else {
        for (const m of [0, 3, 5]) meshes[b + m].castShadow = renderParts.barkShadows && shadowRungs[MESH_RUNG[m]];
        meshes[b + 2].castShadow = renderParts.leafShadows && shadowRungs[MESH_RUNG[2]];
        for (let m = 0; m < MESHES_PER_VARIANT; m++) {
          if (meshes[b + m].visible && meshes[b + m].castShadow) shadowDraws++;
        }
      }
    }
    if (mergedMesh) {
      // One draw for every variant's L2 branches, so the merged mesh is on whenever ANY variant
      // would have been. The cull writes zero instances when none survive, and the CPU gate below
      // saves the renderer the object entirely when the whole rung is empty.
      mergedMesh.visible = pulledActive && mergedWanted;
      if (mergedMesh.visible) draws++;
    }
    submittedDraws = draws;
    submittedShadowDraws = shadowDraws;
    rungMeshesHidden = gated;
  }

  // deterministic variant pick within a species (0 .. variantsPerSpecies-1)
  function variantSel(slot) {
    return (Math.imul(slot + 1, 2654435761) >>> 0) % variantsPerSpecies;
  }

  let overflowWarned = false;
  let droppedInstances = 0;      // dropped by capPerVariant THIS rebuild, not once ever
  let rebuilds = 0;
  function rebuild() {
    rebuilds++;
    countsArray.fill(0);
    let changedStart = srcArray.length, changedEnd = 0;
    // NOTE: srcArray is intentionally NOT zeroed. The cull kernel only reads slots where
    // localSlot < srcCounts[g] (== countsArray[g]); every slot beyond a variant's live
    // count is never sampled, so stale data past the count can't leak into a draw. Skipping
    // the full V*CAP*8 fill(0) (~196k floats at cap 2048) removes it from the hot rebuild path.
    let total = 0, dropped = 0;
    for (const records of chunkRecords.values()) {
      for (const r of records) {
        const g = r.speciesIdx * variantsPerSpecies + variantSel(r.slot);
        if (g < 0 || g >= V) continue;
        if (!variantReady[g]) continue;
        const slot = countsArray[g];
        if (slot >= CAP) { dropped++; continue; }         // variant window full; drop extras
        countsArray[g] = slot + 1;
        const base = (g * CAP + slot) * 8;
        // Records are global; the buffer is render-local, and the cull compares against a
        // render-local camera. A record that carries its ground height is trusted; heightAt is
        // the fallback, asked in global coordinates and answering in them.
        const ground = Number.isFinite(r.ground) ? r.ground : heightAt(r.x, r.z);
        const y = ground + treeBaseOffset - originY;
        // Compare in storage precision: double-precision placement values otherwise look changed
        // on every rebuild after their first Float32 write. Spare fields remain zero from allocation.
        const x32 = Math.fround(r.x - originX), y32 = Math.fround(y), z32 = Math.fround(r.z - originZ);
        const scale32 = Math.fround(r.scale), yaw32 = Math.fround(r.yaw);
        if (srcArray[base] !== x32 || srcArray[base + 1] !== y32 || srcArray[base + 2] !== z32
          || srcArray[base + 3] !== scale32 || srcArray[base + 4] !== yaw32) {
          srcArray[base] = x32; srcArray[base + 1] = y32; srcArray[base + 2] = z32;
          srcArray[base + 3] = scale32; srcArray[base + 4] = yaw32;
          changedStart = Math.min(changedStart, base);
          changedEnd = Math.max(changedEnd, base + 8);
        }
        total++;
      }
    }
    cpuInstances = total;
    droppedInstances = dropped;
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
      variantPopulated[g] = vis ? 1 : 0;
    }
    visibleVariants = visCount;
    rungGateDirty = true;
    syncRenderParts();
    if (dropped > 0 && !overflowWarned) {
      overflowWarned = true;
      console.warn(`[forest-gpu] dropped ${dropped} instances this rebuild: a variant exceeded capPerVariant=${CAP}. Raise capPerVariant.`);
    }
    if (changedEnd > changedStart) {
      // Preserve any pending upload when a host rebuilds again before the renderer consumes it.
      // One merged range also avoids turning small scattered edits into many queue submissions.
      for (const range of srcAttr.updateRanges) {
        changedStart = Math.min(changedStart, range.start);
        changedEnd = Math.max(changedEnd, range.start + range.count);
      }
      srcAttr.clearUpdateRanges();
      srcAttr.addUpdateRange(changedStart, changedEnd - changedStart);
      srcAttr.needsUpdate = true;
    }
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
  let cullEstimates = 0;         // how often the scan below ran; a per-frame caller is a bug
  function computeCullEstimate() {
    cullEstimates++;
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
          const treeRadius = uTreeRadius.value * scale * uTreeScale.value;
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
  // P5/Milestone 6 (finding 5): live A/B for the FrontSide default chosen above. Off (default,
  // matches the shipped FrontSide default) = L1/coarse-L2 leaves + billboards render FrontSide,
  // the winding-fixed cheap path; On = force THREE.DoubleSide on those SAME materials so the
  // two are directly comparable in one running session, same "toggle measures a deliberate
  // re-enable, not the fix itself" contract as deadfall.js's "Deadfall double-sided" toggle.
  // Does NOT affect L0 leaf materials (hardcoded DoubleSide, see the comment where leafMat is
  // created) -- only the materials tracked in sideSwitchableMats.
  globalThis.window?.perfAB?.addToggle('Tree leaves double-sided', false, (v) => {
    const side = v ? THREE.DoubleSide : THREE.FrontSide;
    for (const mat of sideSwitchableMats) {
      mat.side = side;
      mat.needsUpdate = true;
    }
  });

  // The merged reset runs with the per-variant one, the merged finalizer after the rest, so the
  // indirect instanceCount is written in the same submit the draw reads it from.
  const mergedResets = resetMerged ? [resetMerged] : [];
  const mergedFinalizers = finalizeMerged ? [finalizeMerged] : [];
  const computeNodes = [reset, ...mergedResets, cull, ...finalizersA, ...finalizersB, ...mergedFinalizers];
  const activeFinalizersA = [], activeFinalizersB = [];
  function syncActiveFinalizers() {
    activeFinalizersA.length = 0;
    activeFinalizersB.length = 0;
    for (let g = 0; g < V; g++) if (variantReady[g]) {
      activeFinalizersA.push(finalizersA[g]);
      activeFinalizersB.push(finalizersB[g]);
    }
  }
  syncActiveFinalizers();

  async function warmNodes(nodes, yieldFn, shouldContinue) {
    for (let i = 0; i < nodes.length; i++) {
      if (!shouldContinue()) return false;
      await renderer.computeAsync(nodes[i]);
      if (i + 1 < nodes.length) await yieldFn();
    }
    markDirty();
    return nodes.length;
  }

  return {
    meshes,
    variantMeshes(g) {
      if (!Number.isInteger(g) || g < 0 || g >= V) return [];
      const start = g * MESHES_PER_VARIANT;
      const own = meshes.slice(start, start + MESHES_PER_VARIANT);
      // The merged mesh belongs to no variant. It rides out with wave 0 so it is compiled and
      // added to the scene by the host's existing per-wave publication, not by a second path.
      return (g === 0 && mergedMesh) ? [...own, mergedMesh] : own;
    },
    installVariant(g, variant) {
      if (!Number.isInteger(g) || g < 0 || g >= V || !variant) return false;
      const branchesL1Geo = variant.branchesLod1 ?? variant.branches;
      const branchesL2Geo = variant.branchesLod2 ?? variant.branches;
      const geos = [
        variant.branches, variant.leaves, variant.shadow,
        branchesL1Geo, variant.leavesMid ?? variant.leaves, branchesL2Geo, variant.leavesCoarse,
      ];
      const attrs = indirectAttrs[g];
      const indirect = [
        attrs.branchesL0, attrs.leavesL0, attrs.shadowL0,
        attrs.branchesL1, attrs.leavesL1, attrs.branchesL2, attrs.coarseLeavesL2,
      ];
      const start = g * MESHES_PER_VARIANT;
      for (let m = 0; m < 7; m++) {
        const old = meshes[start + m].geometry;
        meshes[start + m].geometry = drawableGeometry(geos[m], indirect[m]);
        geometryPool.release(old);
        indirect[m].array[0] = geos[m].index.count;
        indirect[m].needsUpdate = true;
      }
      if (HAS_BILLBOARDS) {
        const billGeo = variantBillboardGeo(variant);
        billGeo.instanceCount = CAP;
        billGeo.indirect = attrs.billboardL3;
        const old = meshes[start + 7].geometry;
        meshes[start + 7].geometry = billGeo;
        geometryPool.release(old);
      }
      if (SHADOW_LIST) {
        const pairs = [[MAIN_MESHES, variant.branchesLod2 ?? variant.branches, attrs.barkShadow], [MAIN_MESHES + 1, variant.shadow, attrs.leafShadow]];
        for (const [m, geo, attr] of pairs) {
          const old = meshes[start + m].geometry;
          meshes[start + m].geometry = drawableGeometry(geo, attr);
          geometryPool.release(old);
          attr.array[0] = geo.index.count;
          attr.needsUpdate = true;
        }
      }
      if (arenaOk) repackArenaVariant(g, variant);
      palette.variants[g] = variant;
      uTreeRadius.value = Math.max(uTreeRadius.value, variantCanopyRadius(variant));
      uTreeHeight.value = Math.max(uTreeHeight.value, variantHeight(variant));
      markDirty();
      return true;
    },
    setVariantReady(g, ready = true) {
      if (!Number.isInteger(g) || g < 0 || g >= V) return false;
      const next = ready ? 1 : 0;
      if (variantReady[g] === next) return false;
      variantReady[g] = next;
      readyVariantCount += next ? 1 : -1;
      syncActiveFinalizers();
      syncRenderParts();
      // Source counts intentionally exclude unfinished variants. Rebuild once so activating a
      // wave uploads its matching records, or deactivating one removes them from cull work.
      needsRebuild = true;
      return true;
    },
    // Drive the same material binding the baked path uses: fn(branchMat, leafMat) is called once
    // per role pair (procedural bark colorNode, or authored bark/leaf maps); the materials are
    // shared by every variant.
    applyTextureSet(fn) {
      fn(branchMats.L0, leafMats.L0);
      fn(branchMats.L1, leafMats.L1);
      fn(branchMats.L2, coarseMat);
      // The merged L2 material takes the same bark binding; its userData.pulledNodes tells a
      // binder that uv and vertex colour come from the arena, not from vertex attributes.
      if (mergedMat) fn(mergedMat, coarseMat);
      if (SHADOW_LIST) fn(shadowMats.bark, shadowMats.leaf);   // the leaf cutout needs its map
    },
    get materials() { return sharedMats.slice(); },
    get billboardMaterials() { return billboardMats; },
    setRenderParts(partial = {}) {
      for (const key of ['bark', 'leaves', 'billboards', 'barkShadows', 'leafShadows']) {
        if (partial[key] !== undefined) renderParts[key] = !!partial[key];
      }
      syncRenderParts();
    },
    refreshVisibility: syncRenderParts,
    setTreeScale(v) {
      const next = Math.max(0.1, Math.min(2, Number(v) || 1));
      if (uTreeScale.value !== next) { uTreeScale.value = next; markDirty(); }
    },
    setLeafScale(v) {
      uLeafScale.value = Math.max(0.1, Math.min(2, Number(v) || 1));
    },
    setFarLeavesDoubleSided(v) {
      const side = v ? THREE.DoubleSide : THREE.FrontSide;
      for (const mat of sideSwitchableMats) {
        mat.side = side;
        mat.needsUpdate = true;
      }
    },
    applyBillboardMap(g, tex) {
      if (!HAS_BILLBOARDS) return false;
      const t = texture(tex);
      billboardMats[g].colorNode = vec4(t.rgb.mul(uBillBrightness), t.a);
      billboardMats[g].needsUpdate = true;
      return true;
    },
    setBillboardBrightness(val) { uBillBrightness.value = val; },
    _palette: palette,
    // Chunk mutations only flag a pending rebuild; the actual rebuild() (full-window rescan
    // + buffer refill + visibility gating) runs at most once per frame from update()'s top,
    // debouncing the churn when many setChunk/clearChunk calls land in one frame's batch.
    setChunk(key, records) { chunkRecords.set(key, records); needsRebuild = true; },
    setChunks(map) { for (const [k, v] of map) chunkRecords.set(k, v); needsRebuild = true; },
    clearChunk(key) { if (chunkRecords.delete(key)) needsRebuild = true; },
    // Base Game's render origin. Marks a rebuild rather than editing the buffer in place: the
    // heights have to be re-sampled against the new origin anyway.
    setWorldOrigin(x, y, z) {
      if (originX === x && originY === y && originZ === z) return;
      originX = x; originY = y; originZ = z;
      needsRebuild = true;
    },
    get worldOrigin() { return [originX, originY, originZ]; },
    // What the CPU last uploaded. Read-only, and read by the Node tests: without it the only way
    // to check that a rebase moved the instances is to look at the screen.
    get sourceArray() { return srcArray; },
    get sourceAttribute() { return srcAttr; }, // read-only inspection of pending upload ranges
    get sourceCounts() { return countsArray; },
    get slotStride() { return CAP; },
    setTreeBaseOffset(v) {
      if (!Number.isFinite(v) || treeBaseOffset === v) return;
      treeBaseOffset = v;
      needsRebuild = true;
    },
    setLeafSway(v) { uLeafSway.value = Number.isFinite(v) ? v : 0; },
    // Per-rung visibility (D5b). Accepts an array or an object keyed by rung index.
    setLodEnabled(next) {
      let changed = false;
      for (let l = 0; l < LODS; l++) {
        const v = next?.[l];
        if (v === undefined) continue;
        if (lodEnabled[l] !== !!v) { lodEnabled[l] = !!v; changed = true; }
      }
      if (changed) syncRenderParts();
    },
    get lodEnabled() { return [...lodEnabled]; },
    // Frames between Hi-Z re-tests while the camera is under its move and turn thresholds.
    setHizRecullFrames(n) { hizRecullFrames = Math.max(1, Math.round(Number.isFinite(n) ? n : 4)); },
    get hizRecullFrames() { return hizRecullFrames; },
    setShadowRungs(next) {
      let changed = false;
      for (let l = 0; l < LODS; l++) {
        const v = next?.[l];
        if (v === undefined || shadowRungs[l] === !!v) continue;
        shadowRungs[l] = !!v; changed = true;
      }
      if (changed) syncRenderParts();
    },
    get shadowRungs() { return [...shadowRungs]; },
    // Shadow list radius. 0 empties the list and hides the shadow-only meshes; without a shadow
    // layer this is a no-op and the per-rung castShadow flags above still decide.
    setShadowReach(m) {
      const next = Number.isFinite(m) ? Math.max(0, m) : 0;
      if (uShadowReach.value === next) return;
      uShadowReach.value = next;
      markDirty();
      syncRenderParts();
    },
    get shadowReach() { return uShadowReach.value; },
    get shadowLayer() { return SHADOW_LAYER; },
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
      // The widest XZ angle the view reaches, from the vertical fov, the aspect and the pitch.
      // cos(vfov/2) alone was narrower than a wide screen and much narrower than a camera looking
      // down, so trees at the sides were culled and popped in as the camera turned toward them.
      // forward.y goes in unguarded: straight down is exactly the case the helper answers -1 for.
      const camFovCos = camera.isPerspectiveCamera
        ? frustumConeCos(camera.fov, camera.aspect, _fwd3.y)
        : uFovCos.value;
      const camMoved = (camX - lastCamX) ** 2 + (camZ - lastCamZ) ** 2
        > recullMoveDist * recullMoveDist;
      // A cone that WIDENED since the last recull re-culls at once: the stale narrower cone is
      // hiding visible trees. A cone that narrowed waits for the ordinary thresholds, since a
      // stale wide cone only passes extra trees. Pitch moves every mouse-look frame, so an
      // unconditional compare would have re-culled every frame the way the old epsilon gate did.
      const coneWidened = camFovCos < uFovCos.value - 1e-3;
      const camTurned = camFx * lastCamFx + camFz * lastCamFz < recullHeadingCos || coneWidened;
      const firstRecull = !Number.isFinite(lastCamX) || !Number.isFinite(lastCamZ)
        || !Number.isFinite(lastCamFx) || !Number.isFinite(lastCamFz);
      // The pyramid is per frame; its clock is hizRecullFrames, hand-synced with forest-cull.js's
      // shouldRecull (hizFrames). A toggle of the sampler counts as a change at once.
      const hizSynced = hizSampler ? hizSampler.sync() : false;
      const hizOn = !!hizSampler && hizSampler.enabled;
      hizFramesSince++;
      const hizDue = hizSynced && (!hizOn || hizFramesSince >= hizRecullFrames || hizOn !== lastHizOn);
      lastHizOn = hizOn;
      if (!dirty && !firstRecull && !camMoved && !camTurned && !hizDue) {
        skippedReculls++;
        return;
      }
      hizFramesSince = 0;
      uCam.value.set(camX, camZ);
      uCamFwd.value.set(camFx, camFz);
      uFovCos.value = camFovCos;
      await renderer.computeAsync([reset, ...mergedResets, cull, ...activeFinalizersA, ...activeFinalizersB, ...mergedFinalizers]);
      lastCamX = camX;
      lastCamZ = camZ;
      lastCamFx = camFx;
      lastCamFz = camFz;
      dirty = false;
      reculls++;
      if (RUNG_GATE) { rungGateDirty = true; syncRenderParts(); }
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
    // Three's computeAsync initializes the renderer asynchronously but creates a missing compute
    // pipeline synchronously after that. Warm one node per yielded task while the host still shows
    // its loading state, so the first visible recull does not discover the entire chain at once.
    warmupComputeShared(yieldFn = async () => {}, shouldContinue = () => true) {
      return warmNodes([reset, ...mergedResets, cull, ...mergedFinalizers], yieldFn, shouldContinue);
    },
    warmupVariant(g, yieldFn = async () => {}, shouldContinue = () => true) {
      if (!Number.isInteger(g) || g < 0 || g >= V) return false;
      return warmNodes([finalizersA[g], finalizersB[g]], yieldFn, shouldContinue);
    },
    warmupCompute(yieldFn = async () => {}, shouldContinue = () => true) {
      return warmNodes(computeNodes, yieldFn, shouldContinue);
    },
    get summary() {
      return {
        draws: submittedDraws,
        shadowDraws: submittedShadowDraws,
        rungMeshesHidden,
        rungGate: RUNG_GATE,
        rebuilds,
        visibleVariants,
        readyVariants: readyVariantCount,
        variants: V,
        instances: cpuInstances,
        capacity: SRC_TOTAL,
        droppedInstances,
        truncating: droppedInstances > 0,
        cullEstimates,
        reculls,
        skippedReculls,
        lodCount: LODS,
        hasBillboards: HAS_BILLBOARDS,
        shadowList: SHADOW_LIST,
        shadowReach: uShadowReach.value,
        computePipelines: computeNodes.length,
        drawMode: PULLED ? (pulledActive ? opts.drawMode : 'variants-fallback') : 'variants',
        pulledMapping: arenaOk ? (PULLED_COMPACT ? 'compact' : 'slots') : null,
        pulledActive,
        pulledAdmission: admission,
        pulledArena: arenaOk ? {
          vertexSlot: arenaSlots.vertexSlot, indexSlot: arenaSlots.indexSlot,
          vertexBytes: arena.vertexData.byteLength, indexBytes: arena.indexData.byteLength,
          instanceBytes: mergedAttr ? mergedAttr.array.byteLength : 0, overflows: arenaOverflows,
          chunk: PULLED_COMPACT ? COMPACT_CHUNK : null,
        } : null,
        pulledError: arenaFailure,
      };
    },
    // `summary` above is the allocation-free, scan-free read for a per-frame caller. This one
    // runs computeCullEstimate over every live instance: a panel or a capture, never the loop.
    // draws is the number of main-pass meshes left visible, not renderer submissions across shadow
    // or auxiliary passes. visibleVariants exposes how many variants survived the zero-instance gate;
    // variants is still the total variant count for reference. rejectedFrustum/rejectedFar/
    // lod0-2/billboard instance counts are lazy CPU estimates (see computeCullEstimate above) —
    // only computed when `stats` is actually read.
    get stats() {
      const est = computeCullEstimate();
      return {
        draws: submittedDraws, shadowDraws: submittedShadowDraws,
        visibleVariants, instances: cpuInstances, variants: V,
        reculls, skippedReculls, dirty, cullDispatchInstances: SRC_TOTAL,
        capacity: SRC_TOTAL, capPerVariant: CAP, droppedInstances, truncating: droppedInstances > 0,
        cullEstimates,
        lodEnabled: [...lodEnabled], shadowRungs: [...shadowRungs],
        lodR0: uLodR0.value, lodR1: uLodR1.value, lodR2: uLodR2.value,
        maxDrawRadius: uMaxDrawRadius.value, coneEnabled: uConeEnabled.value >= 0.5,
        rejectedFrustum: est.rejectedFrustum, rejectedFar: est.rejectedFar,
        lod0Instances: est.lod0, lod1Instances: est.lod1, lod2Instances: est.lod2,
        billboardInstances: est.billboard,
        treeScale: uTreeScale.value, leafScale: uLeafScale.value,
        renderParts: { ...renderParts },
      };
    },
    // Storage attributes have no dispose event, and ComputeNode.dispose() frees pipelines and bind
    // groups but not the buffers, so a host that rebuilds the forest leaks them without this. Same
    // guarded renderer._attributes path grass-compute.js uses.
    dispose() {
      removePulledListener();
      const mats = new Set();
      meshes.forEach(m => {
        geometryPool.release(m.geometry);
        if (Array.isArray(m.material)) m.material.forEach(mat => mats.add(mat));
        else mats.add(m.material);
      });
      mats.forEach(m => m.dispose());
      for (const node of computeNodes) {
        try { node?.dispose?.(); } catch { /* already gone */ }
      }
      const attrs = renderer?._attributes;
      if (attrs?.delete) {
        const owned = [srcAttr, drawAttr, countsAttr, survAttr];
        if (arenaOk) {
          owned.push(arenaVertAttr, arenaIdxAttr, arenaCountAttr, mergedIndirect);
          if (mergedAttr) owned.push(mergedAttr, mergedCountAttr);
        }
        for (const a of indirectAttrs) owned.push(...Object.values(a));
        for (const a of owned) { try { attrs.delete(a); } catch { /* never uploaded */ } }
      }
    },
  };
}
