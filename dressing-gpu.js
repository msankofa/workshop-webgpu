// dressing-gpu.js -- a GENERALIZED reset -> cull -> finalize -> indirect-draw instancing host,
// factored out of plants-gpu.js's spine (studied, NOT edited -- plants-gpu.js stays exactly as
// it is; see docs/understory-overhaul-plan.md open question #5, "approved: factor a new
// parametric host rather than copy the spine twice"). Rocks (Phase 3 / merged-plan row #7) are
// the first consumer; deadfall/fungi (Phase 4 / row #8) are meant to reuse this same file --
// migrating plants.js onto it is a LATER, separately-coordinated step (TODO, not done here).
//
// Unlike plants-gpu.js (one global CAP shared by every geometry variant of one species table,
// one shared cull radius), this host takes an explicit, arbitrarily-long list of independent
// GROUPS, each with its own instance cap, cull radius/start, shadow flags, and material --
// exactly what rocks need: boulders cast shadows out to a normal draw distance, scree doesn't
// cast shadows and needs a short cull radius (~40-60m) so overdraw of thousands of tiny stones
// never shows up in the per-pass GPU ms (merged-plan perf gate).
import * as THREE from 'three';
import {
  MeshStandardNodeMaterial, StorageInstancedBufferAttribute, StorageBufferAttribute,
  IndirectStorageBufferAttribute,
} from 'three/webgpu';
import {
  Fn, If, instanceIndex, storage, uniform, int, uint, float, vec2, vec3, cos, sin,
  positionLocal, normalLocal, clamp, length, atomicAdd, atomicStore, atomicLoad, bitcast, floor,
} from 'three/tsl';

// per-(worldX,worldZ,salt) pseudo-random in [0,1) -- deliberately a small standalone copy of
// plants-gpu.js's posRandFn (that function is not exported there, and plants-gpu.js is
// explicitly out of scope for edits). Stays stable across rebuild()'s slot reassignment
// because it's keyed by world position, not buffer slot index.
const asU = (iNode) => bitcast(iNode, 'uint');
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

// Compose an XZY-order Euler rotation (X tilt -> Z tilt -> Y yaw) applied identically to
// position and normal, so tilted boulders/logs light correctly. No mat3/quaternion TSL type
// is used anywhere else in this codebase, so this stays plain trig composition, matching the
// yaw-only rotation plants-gpu.js already does (just extended to 3 axes).
function rotateXZY(v, cx, sx, cz, sz, cy, sy) {
  const x1 = v.x;
  const y1 = v.y.mul(cx).sub(v.z.mul(sx));
  const z1 = v.y.mul(sx).add(v.z.mul(cx));
  const x2 = x1.mul(cz).sub(y1.mul(sz));
  const y2 = x1.mul(sz).add(y1.mul(cz));
  const z2 = z1;
  const x3 = x2.mul(cy).add(z2.mul(sy));
  const y3 = y2;
  const z3 = z2.mul(cy).sub(x2.mul(sy));
  return vec3(x3, y3, z3);
}

// opts: { renderer, camera, heightAt (optional, used only as the y-fallback when a record
//         omits y), groups }.
// opts.groups: [{
//   key,                          // debug label (mesh.name)
//   geometry,                     // THREE.BufferGeometry, INDEXED (index.count feeds the
//                                 // IndirectStorageBufferAttribute draw-args -- same
//                                 // convention as plants-gpu.js/grass.js/forest-gpu.js).
//   cap,                          // max live instances for this group (default 256)
//   cullRadius, cullStart,        // world units; edge is a dithered stochastic fade band
//                                 // (same technique as plants-gpu.js's cull kernel), not a
//                                 // hard pop ring. cullStart defaults to 0.7*cullRadius.
//   castShadow = true, receiveShadow = true,
//   buildMaterial(nodes) => a MeshStandardNodeMaterial-family node material. `nodes` is
//     { world, nWorld, yaw, tiltX, tiltZ, extra } -- vertex-stage TSL nodes for this group's
//     instances; `extra` is the instance record's 4th free float (rec1.w), free for callers
//     to carry e.g. per-instance moisture into their own colorNode (rocks.js's
//     buildRockMaterial's `moistureNode` param is meant to be `nodes.extra`).
// }]
// Records passed to setChunk/setChunks/setGroupRecords: { x, y?, z, scale, yaw=0, tiltX=0,
// tiltZ=0, extra=0, groupIdx } -- groupIdx selects which of opts.groups this instance renders
// as. Palette-to-group variant selection (which baked geometry an instance uses) happens in
// the placement layer (e.g. rocks-placement.js's `variantIdx` + a small caller-side mapping to
// a flat groups list), not in this generic host.
export function createDressingGPU(opts) {
  const { renderer, camera } = opts;
  const heightAt = opts.heightAt || (() => 0);
  const groupSpecs = opts.groups || [];
  const G = groupSpecs.length;

  const uCam = uniform(new THREE.Vector2());

  const state = groupSpecs.map((spec) => {
    const CAP = spec.cap ?? 256;
    const srcAttr = new StorageInstancedBufferAttribute(new Float32Array(CAP * 8), 8);
    const src = storage(srcAttr, 'vec4', CAP * 2);
    const drawAttr = new StorageInstancedBufferAttribute(new Float32Array(CAP * 8), 8);
    const draw = storage(drawAttr, 'vec4', CAP * 2);
    const countAttr = new StorageBufferAttribute(new Uint32Array(1), 1);
    const srcCount = storage(countAttr, 'uint', 1);
    const survAtomic = storage(new StorageBufferAttribute(new Uint32Array(1), 1), 'uint', 1).toAtomic();
    const indirectAttr = new IndirectStorageBufferAttribute(new Uint32Array([spec.geometry.index.count, 0, 0, 0, 0]), 5);
    const indirectNode = storage(indirectAttr, 'uint', 5);
    const cullRadius = spec.cullRadius ?? 45;
    const uCullRadius = uniform(cullRadius);
    const uCullStart = uniform(spec.cullStart ?? cullRadius * 0.7);

    const reset = Fn(() => { atomicStore(survAtomic.element(uint(0)), uint(0)); })().compute(1);
    const cull = Fn(() => {
      const idx = int(instanceIndex);
      If(idx.lessThan(int(srcCount.element(uint(0)))), () => {
        const rec0 = src.element(idx.mul(uint(2)));
        const rec1 = src.element(idx.mul(uint(2)).add(uint(1)));
        const dist = length(vec2(rec0.x.sub(uCam.x), rec0.z.sub(uCam.y)));
        const gradRange = uCullRadius.sub(uCullStart).max(float(0.001));
        const edge = clamp(dist.sub(uCullStart).div(gradRange), 0, 1);
        const keepRand = posRandFn(rec0.x, rec0.z, int(7));
        const live = dist.lessThan(uCullRadius).and(keepRand.greaterThan(edge));
        If(live, () => {
          const s = atomicAdd(survAtomic.element(uint(0)), uint(1));
          const outBase = s.mul(uint(2));
          draw.element(outBase).assign(rec0);
          draw.element(outBase.add(uint(1))).assign(rec1);
        });
      });
    })().compute(CAP);
    const finalize = Fn(() => { indirectNode.element(1).assign(atomicLoad(survAtomic.element(uint(0)))); })().compute(1);

    return { spec, CAP, srcAttr, src, drawAttr, draw, countAttr, indirectAttr, reset, cull, finalize };
  });

  function instanceNodes(st) {
    const recBase = uint(instanceIndex).mul(uint(2));
    const rec0 = st.draw.element(recBase);
    const rec1 = st.draw.element(recBase.add(uint(1)));
    const scale = rec0.w, yaw = rec1.x, tiltX = rec1.y, tiltZ = rec1.z, extra = rec1.w;
    const cy = cos(yaw), sy = sin(yaw), cx = cos(tiltX), sx = sin(tiltX), cz = cos(tiltZ), sz = sin(tiltZ);
    const rotP = rotateXZY(positionLocal, cx, sx, cz, sz, cy, sy);
    const world = vec3(
      rec0.x.add(rotP.x.mul(scale)),
      rec0.y.add(rotP.y.mul(scale)),
      rec0.z.add(rotP.z.mul(scale)),
    );
    const nWorld = rotateXZY(normalLocal, cx, sx, cz, sz, cy, sy);
    return { world, nWorld, yaw, tiltX, tiltZ, extra };
  }

  const meshes = [];
  for (let g = 0; g < G; g++) {
    const st = state[g];
    const spec = groupSpecs[g];
    const nodes = instanceNodes(st);
    const mat = spec.buildMaterial ? spec.buildMaterial(nodes)
      : new MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
    mat.positionNode = nodes.world;
    // Only supply the instance-rotated world normal if the material did NOT already set its
    // own normalNode. Materials that want detail normals (e.g. rocks.js's triplanar
    // world-locked deviation) compose ON TOP of nodes.nWorld themselves and set normalNode;
    // clobbering it here would kill their detail map and fall back to flat vertex normals.
    if (!mat.normalNode) mat.normalNode = nodes.nWorld;
    // Clone the caller's geometry per group: instanceCount/indirect are written onto the
    // BufferGeometry, so sharing one geometry across two groups would corrupt the first
    // group's indirect binding. (Same clone-per-variant pattern as plants-gpu.js.)
    const geom = spec.geometry.clone();
    geom.instanceCount = st.CAP;
    geom.indirect = st.indirectAttr;
    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = spec.key || `dressing${g}`;
    mesh.frustumCulled = false;
    mesh.castShadow = spec.castShadow ?? true;
    mesh.receiveShadow = spec.receiveShadow ?? true;
    mesh.visible = false; // zero-instance gating until the first rebuild populates records
    meshes.push(mesh);
  }

  // ---- CPU: per-chunk placement records -> per-group source buffers ----
  const chunkRecords = new Map(); // chunkKey -> records[] (each record carries groupIdx)
  let cpuInstances = 0;
  let dirty = true, lastCamX = NaN, lastCamZ = NaN;
  let needsRebuild = false;
  let submittedDraws = 0;
  const allRecords = [];

  function rebuild() {
    const camX = camera.position.x, camZ = camera.position.z;
    allRecords.length = 0;
    for (const records of chunkRecords.values()) for (const r of records) allRecords.push(r);
    // Sort by true camera distance (same rationale as plants-gpu.js's rebuild()): Map
    // insertion order would give stale/far chunks priority over what the player just walked
    // next to, which is backwards for a fixed per-group instance cap.
    allRecords.sort((a, b) => {
      const da = (a.x - camX) ** 2 + (a.z - camZ) ** 2;
      const db = (b.x - camX) ** 2 + (b.z - camZ) ** 2;
      return da - db;
    });
    const counts = new Array(G).fill(0);
    let total = 0;
    for (const r of allRecords) {
      const g = r.groupIdx;
      if (g == null || g < 0 || g >= G) continue;
      const st = state[g];
      const slot = counts[g];
      if (slot >= st.CAP) continue; // group window full; drop extras (same policy as plants-gpu.js)
      counts[g] = slot + 1;
      const base = slot * 8;
      const arr = st.srcAttr.array;
      arr[base] = r.x; arr[base + 1] = r.y ?? heightAt(r.x, r.z); arr[base + 2] = r.z; arr[base + 3] = r.scale;
      arr[base + 4] = r.yaw ?? 0; arr[base + 5] = r.tiltX ?? 0; arr[base + 6] = r.tiltZ ?? 0; arr[base + 7] = r.extra ?? 0;
      total++;
    }
    cpuInstances = total;
    let visCount = 0;
    for (let g = 0; g < G; g++) {
      state[g].countAttr.array[0] = counts[g];
      state[g].countAttr.needsUpdate = true;
      state[g].srcAttr.needsUpdate = true;
      const vis = counts[g] > 0;
      if (vis) visCount++;
      meshes[g].visible = vis;
    }
    submittedDraws = visCount;
    dirty = true;
  }

  return {
    meshes,
    setChunk(key, records) { chunkRecords.set(key, records); needsRebuild = true; },
    clearChunk(key) { if (chunkRecords.delete(key)) needsRebuild = true; },
    setChunks(batch, clearKeys = []) {
      let changed = false;
      for (const key of clearKeys) changed = chunkRecords.delete(key) || changed;
      for (const [key, records] of batch) { chunkRecords.set(key, records); changed = true; }
      if (changed) needsRebuild = true;
    },
    async update() {
      if (needsRebuild) { rebuild(); needsRebuild = false; }
      const camX = camera.position.x, camZ = camera.position.z;
      if (!dirty && camX === lastCamX && camZ === lastCamZ) return;
      uCam.value.set(camX, camZ);
      const kernels = [];
      for (const st of state) kernels.push(st.reset, st.cull, st.finalize);
      await renderer.computeAsync(kernels);
      lastCamX = camX; lastCamZ = camZ; dirty = false;
    },
    get stats() { return { draws: submittedDraws, groups: G, instances: cpuInstances }; },
    dispose() {
      // Geometry ownership: the host CLONES each caller geometry per group (see the mesh
      // build above), so it owns and disposes those clones here. The caller still owns and
      // must dispose the ORIGINAL geometries it passed in (e.g. rockPalette.variants).
      const mats = new Set();
      meshes.forEach(m => { m.geometry.dispose(); mats.add(m.material); });
      mats.forEach(m => m.dispose());
    },
  };
}
