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
  atomicAdd, atomicStore, atomicLoad, time, mix, dot, vec4, texture, max,
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

// Per-instance variation tint (hue swing + 22%-dry roll + age darken): a pure-expression TSL
// mirror of plants.js's plantTint() JS reference (test-plant-variation.mjs covers the JS side;
// GPU compute can't import it, so keep these constants in sync by hand if the law changes --
// same convention as forest-cull.js/forest-gpu.js). Built entirely from arithmetic + mix()
// (linear interpolation, not a branch) -- no If() at material scope, per SeedThree
// terrain-material.js's documented gotcha (a top-level If() throws when the node graph builds).
const plantTintNode = Fn(([hue, dryness, age]) => {
  const hueR = hue.mul(0.5).add(1.0), hueG = hue.mul(-0.3).add(1.0), hueB = hue.mul(-0.2).add(1.0);
  const dryR = dryness.mul(0.35).add(1.0), dryG = dryness.mul(-0.28).add(1.0), dryB = dryness.mul(-0.35).add(1.0);
  const ageNorm = clamp(age.sub(0.6).div(0.4), 0, 1);
  const ageR = mix(float(1.06), float(0.88), ageNorm);
  const ageG = mix(float(1.06), float(0.90), ageNorm);
  const ageB = mix(float(1.0), float(0.86), ageNorm);
  return vec3(hueR.mul(dryR).mul(ageR), hueG.mul(dryG).mul(ageG), hueB.mul(dryB).mul(ageB)).max(vec3(0, 0, 0));
});

// age->scale law: mature (age~1) plants render at their full placed scale; young (age~0.6)
// plants are visibly smaller -- same fraction (0.75..1.0) used nowhere else, kept local.
const ageScaleNode = (age) => age.sub(0.6).div(0.4).clamp(0, 1).mul(0.25).add(0.75);

// Wind sway (SeedThree wind.js grassWindPosition, adapted): composed AFTER the instance
// yaw/scale/translate transform (i.e. applied to the already-world-space position), so this is
// a world-space offset, never a vertexNode/local displacement. Phase comes from posRandFn keyed
// on the instance's own world position (stable across rebuild()'s slot-reassigning re-sorts,
// same reasoning as the cull kernel's fade dither above) so instances don't sway in lockstep.
// Amplitude grows with local geometry height (positionLocal.y, pre-transform) squared, same
// quadratic taper wind.js uses for grass blades (base pinned, tip whips).
const WIND_DIR = vec3(0.85, 0, 0.53);
function plantWindOffset(rec0, uWindStrength, uWindSpeed) {
  const phase = posRandFn(rec0.x, rec0.z, int(11)).mul(Math.PI * 2);
  const t = time.mul(uWindSpeed);
  const heightFrac = clamp(positionLocal.y.div(float(1.1)), 0, 1);
  const k = heightFrac.mul(heightFrac);
  const sway = sin(t.mul(1.3).add(phase)).mul(0.7).add(sin(t.mul(2.7).add(phase.mul(1.9))).mul(0.3));
  const amp = uWindStrength.mul(0.16).mul(k);
  return WIND_DIR.mul(sway.mul(amp));
}

// opts: { renderer, camera, palette (from plants.js's createPlantPalette), heightAt,
//         capPerVariant, cullRadius, cullStart, variationStrength, windStrength, windSpeed }
export function createPlantsGPU(opts) {
  const { renderer, camera, palette } = opts;
  const heightAt = opts.heightAt || (() => 0);
  const CAP = opts.capPerVariant ?? 256;
  const V = palette.variants.length;

  // source (CPU-filled on chunk change) and draw (compute-written survivors) buffers:
  // V*CAP instances x 2 vec4 -> rec0=(x,y,z,scale), rec1=(yaw,hue,dryness,age). yzw were free
  // floats reserved for exactly this (Phase 1 per-instance variation) -- no layout change.
  const srcAttr = new StorageInstancedBufferAttribute(new Float32Array(V * CAP * 8), 8);
  const src = storage(srcAttr, 'vec4', V * CAP * 2);
  const drawAttr = new StorageInstancedBufferAttribute(new Float32Array(V * CAP * 8), 8);
  const draw = storage(drawAttr, 'vec4', V * CAP * 2);
  const countsAttr = new StorageBufferAttribute(new Uint32Array(V), 1);
  const srcCounts = storage(countsAttr, 'uint', V);
  const survAttr = new StorageBufferAttribute(new Uint32Array(V), 1);
  const survAtomics = storage(survAttr, 'uint', V).toAtomic();

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
  // Frustum cone in XZ: an instance survives if it is within nearKeep of the camera or inside
  // the camera's horizontal field of view plus a margin. uCosHalf -1 keeps everything (looking
  // straight down, or an orthographic camera). Rotation re-runs the cull like translation does.
  const frustumCull = opts.frustumCull ?? true;
  const uFwd = uniform(new THREE.Vector2(1, 0));
  const uCosHalf = uniform(-1);
  const uNearKeep = uniform(opts.nearKeep ?? 8);
  // Occlusion against flora-occlusion.js's depth image: project the candidate with the same
  // view-projection, read the stored view depth at the point and its four neighbours, and drop
  // it when it is deeper than all of them by more than the bias. Without an occlusion option the
  // test is not compiled in at all.
  const occlusion = opts.occlusion || null;
  const uOccOn = uniform(occlusion && occlusion.enabled ? 1 : 0);
  const uOccVP = uniform(new THREE.Matrix4());
  const uOccTexel = uniform(new THREE.Vector2(1 / 256, 1 / 256));
  const uOccBias = uniform(occlusion ? occlusion.bias : 0.12);
  // keepFn(wx, wy, wz, h, dist): the projection is the visibility test. A candidate survives when
  // its base or its top (h above) projects inside the screen with a margin, or it is within
  // 1.5 m; it is then occlusion-tested at its top, because walls hide things from the ground
  // up. Behind the camera or off screen is simply not visible, never "not occluded".
  const NDC_MARGIN = 1.06;
  const project = (wx, wy, wz) => {
    const clip = uOccVP.mul(vec4(wx, wy, wz, 1.0));
    const w = clip.w;
    const ndc = clip.xy.div(w.max(0.001));
    const onScreen = w.greaterThan(0.05)
      .and(ndc.x.greaterThan(-NDC_MARGIN)).and(ndc.x.lessThan(NDC_MARGIN))
      .and(ndc.y.greaterThan(-NDC_MARGIN)).and(ndc.y.lessThan(NDC_MARGIN));
    return { w, ndc, onScreen };
  };
  // One texture node, sampled five times through .sample(): one binding, not five. The cull
  // stage is near WebGPU's sampled-texture limit (see vegetation.md), so every binding counts.
  const occTex = occlusion ? texture(occlusion.texture) : null;
  const keepFn = occlusion
    ? (wx, wy, wz, h, dist) => {
        const base = project(wx, wy, wz);
        const top = project(wx, wy.add(h), wz);
        const visible = base.onScreen.or(top.onScreen).or(dist.lessThan(1.5));
        // WebGPU samples a render target with row 0 at the top and the WGSL builder adds no flip,
        // so V runs down from clip-space +y.
        const uv = vec2(clamp(top.ndc.x.mul(0.5).add(0.5), 0, 1), clamp(float(0.5).sub(top.ndc.y.mul(0.5)), 0, 1));
        const tx = vec2(uOccTexel.x, 0), tz = vec2(0, uOccTexel.y);
        const far = max(max(occTex.sample(uv).r, occTex.sample(uv.add(tx)).r),
          max(occTex.sample(uv.sub(tx)).r, max(occTex.sample(uv.add(tz)).r, occTex.sample(uv.sub(tz)).r)));
        const occluded = uOccOn.greaterThan(0.5).and(top.onScreen).and(top.w.greaterThan(far.add(uOccBias).add(top.w.mul(0.01))));
        return visible.and(occluded.not());
      }
    : null;
  function syncOcclusion() {
    if (!occlusion) return false;
    const on = occlusion.enabled ? 1 : 0;
    const changed = uOccOn.value !== on || !uOccVP.value.equals(occlusion.viewProj);
    uOccOn.value = on;
    uOccVP.value.copy(occlusion.viewProj);
    uOccTexel.value.copy(occlusion.texel);
    uOccBias.value = occlusion.bias;
    return changed;
  }

  // Variation strength blends the per-instance tint from flat (0, all plants read the
  // species' baked vertex color unmodified) to full (1, the complete hue/dryness/age law) --
  // and wind strength/speed drive plantWindOffset's sway amplitude/tempo. All three are
  // live uniforms (no rebuild needed to change them), matching wind/grass sliders elsewhere.
  const uVariationStrength = uniform(opts.variationStrength ?? 1.0);
  const uWindStrength = uniform(opts.windStrength ?? 0.4);
  const uWindSpeed = uniform(opts.windSpeed ?? 1.0);

  const reset = Fn(() => { atomicStore(survAtomics.element(instanceIndex), uint(0)); })().compute(V);

  const cull = Fn(() => {
    const idx = int(instanceIndex);
    const cap = int(CAP);
    const localSlot = modInt(idx, cap);
    const g = idx.sub(localSlot).div(cap);
    If(localSlot.lessThan(int(srcCounts.element(g))), () => {
      const rec0 = src.element(idx.mul(uint(2)));
      const rec1 = src.element(idx.mul(uint(2)).add(uint(1)));
      const rel = vec2(rec0.x.sub(uCam.x), rec0.z.sub(uCam.y));
      const dist = length(rel);
      const inCone = dist.lessThan(uNearKeep).or(dot(rel.div(dist.max(0.001)), uFwd).greaterThan(uCosHalf));
      const gradRange = uCullRadius.sub(uCullStart).max(float(0.001));
      const edge = clamp(dist.sub(uCullStart).div(gradRange), 0, 1);
      const keepRand = posRandFn(rec0.x, rec0.z, int(7));
      const unoccluded = keepFn ? keepFn(rec0.x, rec0.y, rec0.z, float(1.4), dist) : float(1).greaterThan(0);
      const live = dist.lessThan(uCullRadius).and(keepRand.greaterThan(edge)).and(inCone).and(unoccluded);
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
    // rec1 = (yaw, hue, dryness, age) -- yzw were free floats reserved for exactly this
    // (see file header); no buffer-layout change, just filling fields rebuild() already wrote.
    const yaw = rec1.x, hue = rec1.y, dryness = rec1.z, age = rec1.w;
    const scale = rec0.w.mul(ageScaleNode(age));
    const cy = cos(yaw), sy = sin(yaw);
    const px = positionLocal.x, py = positionLocal.y, pz = positionLocal.z;
    const rx = px.mul(cy).add(pz.mul(sy));
    const rz = pz.mul(cy).sub(px.mul(sy));
    let world = vec3(rec0.x.add(rx.mul(scale)), rec0.y.add(py.mul(scale)), rec0.z.add(rz.mul(scale)));
    // Wind: composed AFTER the yaw/scale/translate transform above, i.e. a world-space offset
    // added to the already-placed instance position -- never folded into positionLocal.
    world = world.add(plantWindOffset(rec0, uWindStrength, uWindSpeed));
    const nx = normalLocal.x, ny = normalLocal.y, nz = normalLocal.z;
    const nWorld = vec3(nx.mul(cy).add(nz.mul(sy)), ny, nz.mul(cy).sub(nx.mul(sy)));
    const tint = mix(vec3(1, 1, 1), plantTintNode(hue, dryness, age), uVariationStrength);
    return { world, nWorld, tint };
  }

  const meshes = [];
  for (let g = 0; g < V; g++) {
    const mat = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 1.0, metalness: 0.0, side: THREE.DoubleSide });
    const n = instanceNodes(g);
    mat.positionNode = n.world;
    mat.normalNode = n.nWorld;
    // material.vertexColors (still true above) multiplies this colorNode by the geometry's
    // baked vertex color automatically (three.js NodeMaterial VERTEX COLORS step) -- so this
    // is purely the tint factor, not a replacement for the baked species color.
    mat.colorNode = n.tint;
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
  let dirty = true, lastCamX = NaN, lastCamZ = NaN, lastFx = NaN, lastFz = NaN, lastCos = NaN;
  const _dir = new THREE.Vector3();
  // Half-angle of the frustum's footprint on the ground plane, widened as the camera pitches.
  function coneFor() {
    if (!frustumCull || !(camera.fov > 0)) return { fx: 1, fz: 0, cos: -1 };
    camera.getWorldDirection(_dir);
    const hl = Math.hypot(_dir.x, _dir.z);
    if (hl < 0.35) return { fx: 1, fz: 0, cos: -1 };
    const halfV = (camera.fov * Math.PI / 180) / 2, halfH = Math.atan(Math.tan(halfV) * (camera.aspect || 1));
    const denom = hl - Math.tan(halfV) * Math.sqrt(Math.max(0, 1 - hl * hl));
    if (denom < 0.2) return { fx: 1, fz: 0, cos: -1 };
    // Quantised so a turning camera re-culls every ~6 degrees, not every frame: the 0.22 rad
    // margin above is wider than one step, so the cone stays conservative between reculls.
    const STEP = 0.1;
    const half = Math.min(Math.PI, Math.ceil((Math.atan(Math.tan(halfH) / denom) + 0.22) / STEP) * STEP);
    const yaw = Math.round(Math.atan2(_dir.z, _dir.x) / STEP) * STEP;
    return { fx: Math.cos(yaw), fz: Math.sin(yaw), cos: Math.cos(half) };
  }
  let needsRebuild = false;   // chunk mutations set this; rebuild() runs once at update() top
  let visibleVariants = 0;    // variants with >0 source records this rebuild
  let submittedDraws = 0;     // meshes actually left visible (== visibleVariants)
  const allRecords = [];      // reused scratch for the per-rebuild distance sort (no realloc)

  // deterministic variant pick within a species (0 .. variantsPerSpecies-1) -- same formula
  // forest-gpu.js uses, so repeated `slot` values pick the same variant consistently.
  function variantSel(slot) {
    return (Math.imul(slot + 1, 2654435761) >>> 0) % palette.variantsPerSpecies;
  }

  function rebuild() {
    countsArray.fill(0);
    // NOTE: srcArray is intentionally NOT zeroed. The cull kernel only reads slots where
    // localSlot < srcCounts[g] (== countsArray[g]); slots past a variant's live count are
    // never sampled, so stale data can't leak into a draw. Skipping the full V*CAP*8 fill(0)
    // keeps the rebuild path light during streaming.
    let total = 0;
    // Sort all pooled instances by true distance to the camera before allocating each
    // variant's CAP slots. chunkRecords is a Map, and Map iteration order is insertion
    // order -- re-setChunk()ing an existing key does NOT move it, and newly-entered
    // (nearest) chunks are appended LAST. Filling slots in Map order therefore gives
    // stale/far chunks priority over whatever the player just walked next to, which is
    // backwards. Sorting by actual instance position here removes any dependency on
    // chunk registration order.
    const camX = camera.position.x, camZ = camera.position.z;
    allRecords.length = 0;
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
      srcArray[base] = r.x; srcArray[base + 1] = r.y ?? heightAt(r.x, r.z); srcArray[base + 2] = r.z; srcArray[base + 3] = r.scale;
      // rec1 = (yaw, hue, dryness, age) -- hue/dryness/age default to "no variation" (0,0,1)
      // for any caller that hasn't adopted plants-placement.js's rollPlantVariation yet.
      srcArray[base + 4] = r.yaw;
      srcArray[base + 5] = r.hue ?? 0;
      srcArray[base + 6] = r.dryness ?? 0;
      srcArray[base + 7] = r.age ?? 1;
      total++;
    }
    cpuInstances = total;
    // Zero-instance visibility gating: hide the single mesh of any variant with no source
    // records so Three's render list skips its always-on indirect draw (frustumCulled=false +
    // instanceCount pinned to CAP). The reset->cull->finalize compute passes run unconditionally
    // off storage buffers (unaware of mesh.visible), so a hidden variant stays correct and
    // reappears immediately when it repopulates. See docs/subsystems/vegetation.md.
    let visCount = 0;
    for (let g = 0; g < V; g++) {
      const vis = countsArray[g] > 0;
      if (vis) visCount++;
      meshes[g].visible = vis;
    }
    visibleVariants = visCount;
    submittedDraws = visCount;
    srcAttr.needsUpdate = true;
    countsAttr.needsUpdate = true;
    dirty = true;
  }

  return {
    meshes,
    // Chunk mutations only flag a pending rebuild; the actual rebuild() (full-window rescan +
    // O(n log n) distance sort + buffer refill + visibility gating) runs at most once per frame
    // from update()'s top, debouncing the churn when a frame streams in a batch of chunks.
    setChunk(key, records) { chunkRecords.set(key, records); needsRebuild = true; },
    clearChunk(key) { if (chunkRecords.delete(key)) needsRebuild = true; },
    setChunks(batch, clearKeys = []) {
      let changed = false;
      for (const key of clearKeys) changed = chunkRecords.delete(key) || changed;
      for (const [key, records] of batch) { chunkRecords.set(key, records); changed = true; }
      if (changed) needsRebuild = true;
    },
    setCullRadius(r) { if (uCullRadius.value !== r) { uCullRadius.value = r; dirty = true; } },
    setCullStart(r) { if (uCullStart.value !== r) { uCullStart.value = r; dirty = true; } },
    // Live uniforms -- no rebuild needed, unlike density/clustering which require re-placing.
    setVariationStrength(v) { uVariationStrength.value = v; },
    setWindStrength(v) { uWindStrength.value = v; },
    setWindSpeed(v) { uWindSpeed.value = v; },
    async update() {
      // Run any deferred rebuild before the cull reads the source buffer/counts. rebuild()
      // sets dirty, so the camera-unchanged skip below won't stale a fresh chunk batch.
      if (needsRebuild) { rebuild(); needsRebuild = false; }
      const camX = camera.position.x, camZ = camera.position.z;
      const cone = coneFor();
      const occChanged = syncOcclusion();
      if (!dirty && !occChanged && camX === lastCamX && camZ === lastCamZ && cone.fx === lastFx && cone.fz === lastFz && cone.cos === lastCos) return;
      uCam.value.set(camX, camZ);
      uFwd.value.set(cone.fx, cone.fz); uCosHalf.value = cone.cos;
      lastFx = cone.fx; lastFz = cone.fz; lastCos = cone.cos;
      await renderer.computeAsync([reset, cull, ...finalizers]);
      lastCamX = camX; lastCamZ = camZ; dirty = false;
    },
    // draws is the number of meshes actually submitted (== visibleVariants), not the fixed V;
    // visibleVariants exposes how many of the V variants survived the zero-instance gate.
    get stats() { return { draws: submittedDraws, visibleVariants, instances: cpuInstances, variants: V }; },
    // Instances the last cull kept, read back from the survivor atomics. A GPU round trip, so
    // call it on a timer for a readout, never per frame.
    async readSurvivors() {
      const buf = await renderer.getArrayBufferAsync(survAttr);
      let n = 0;
      for (const v of new Uint32Array(buf)) n += v;
      return n;
    },
    dispose() {
      const mats = new Set();
      meshes.forEach(m => { m.geometry.dispose(); mats.add(m.material); });
      mats.forEach(m => m.dispose());
    },
  };
}
