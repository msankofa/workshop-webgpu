// grass-compute.js
// GPU-driven grass: a per-frame compute pass regenerates candidate blades over a
// world-cell window around the camera, plants them on the TSL terrain height, culls
// (water / radius / density falloff), and atomicAdds survivors into a GPU-resident
// instance buffer that drives ONE drawIndexedIndirect. Placement is a pure function
// of (cell,slot) so blades never swim; the height function bit-matches
// terrain-field.js (Node-tested twin: grass-height-ref.js) so blades sit on the
// visible ground and water rejection matches the lakes. API forms confirmed by
// grass-compute-spike.html.
//
// Anchor mode (opts.surfaceGeometry, used for authored maps): instead of generating
// blade positions procedurally on a heightfield, blades are planted on anchor points
// sampled from the map's actual triangle mesh (grass-anchors.js) so they follow cave
// floors, overhangs, and floating islands exactly. Chunks of anchors near the camera
// are sampled on the CPU (budgeted per frame) and streamed into a GPU storage buffer;
// the cull kernel then reads anchors instead of synthesizing positions. The instance
// buffer, blade material, and indirect draw are shared between both modes.
import * as THREE from 'three';
import {
  MeshStandardNodeMaterial, MeshLambertNodeMaterial, StorageInstancedBufferAttribute, StorageBufferAttribute,
  IndirectStorageBufferAttribute,
} from 'three/webgpu';
import {
  Fn, If, instanceIndex, storage, uniform, attribute, float, bool, int, uint, bitcast, modInt,
  vec2, vec3, vec4, sin, cos, floor, mix, clamp, length, smoothstep, positionLocal, positionWorld, max, min,
  atomicAdd, atomicStore, atomicLoad, texture, dot, normalize, cameraViewMatrix, pow, select, sqrt, ceil, userData,
  renderGroup,
} from 'three/tsl';
import { buildBladeGeometry, buildGrassNoiseFns, getGrassStyleAtlas } from './grass.js';
import { createGrassLook } from './grass-look.js';
import { createHizSampler } from './hiz-test.js';
import { FIBER_REMAP_MIN, FIBER_REMAP_MAX, STYLE_KEYS } from './grass-textures.js';
import { maxInstances, perCellCount, tierLayout, thinTiers, tierRegions, tierDue } from './grass-cells.js';
import {
  buildChunkIndex, sampleChunk, slotCapacityForRadius,
  chunkKey, parseChunkKey, pointToChunkDist,
} from './grass-anchors.js';

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

// per-(anchorIndex,salt) pseudo-random in [0,1) for anchor-mode blades (yaw, height
// variation, edge-fade keep). A pure function of the buffer slot index, so blades
// stay stable for as long as their chunk is resident.
const anchorRandFn = Fn(([i, salt]) => {
  let h = asU(i).mul(uint(747796405)).add(uint(2891336453));
  h = h.bitXor(h.shiftRight(uint(15))).mul(uint(2246822519));
  h = h.bitXor(asU(salt).mul(uint(2654435761)));
  h = h.bitXor(h.shiftRight(uint(13))).mul(uint(3266489917));
  h = h.bitXor(h.shiftRight(uint(16)));
  return h.toFloat().div(4294967296.0);
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

export const COLOR_MODES = Object.freeze(['palette', 'ground', 'proof']);

// Up to three distance tiers, sorted by radius, the last always open-ended.
export function normaliseTierClocks(spec) {
  const d = [{ move: 0, turn: 0, frames: 1 }, { move: 0.5, turn: 3, frames: 4 }, { move: 2, turn: 8, frames: 16 }];
  const list = Array.isArray(spec) ? spec : [];
  return d.map((def, i) => {
    const c = list[i] || {};
    const num = (v, fallback) => Number.isFinite(v) && v >= 0 ? v : fallback;
    return { move: num(c.move, def.move), turn: num(c.turn, def.turn), frames: Math.max(1, Math.round(num(c.frames, def.frames))) };
  });
}

export function normaliseTiers(spec) {
  const list = (Array.isArray(spec) ? spec : [])
    .map(t => ({ radius: Number(t?.radius), density: Math.max(0, Math.min(1, Number(t?.density ?? 1))) }))
    .filter(t => Number.isFinite(t.radius) && t.radius > 0 || t.radius === Infinity)
    .sort((a, b) => a.radius - b.radius)
    .slice(0, 3);
  if (!list.length) return [{ radius: Infinity, density: 1 }];
  list[list.length - 1].radius = Infinity;
  return list;
}

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
    // Fade controls. null = follow: fadeEnd the radius, the tint band the keep band.
    fadeEnd: opts.fadeEnd ?? null,
    fadeCurve: opts.fadeCurve ?? 1,
    fadeHeight: opts.fadeHeight ?? 0,
    fadeWidth: opts.fadeWidth ?? 0,
    tintFadeStart: opts.tintFadeStart ?? null,
    tintFadeEnd: opts.tintFadeEnd ?? null,
    nearFadeStart: opts.nearFadeStart ?? 0,
    nearFadeEnd: opts.nearFadeEnd ?? 0,
    maxBlades: opts.maxBlades ?? 0,
    bladeHeight: opts.bladeHeight ?? 1.0,
    bladeWidth: opts.bladeWidth ?? 1.0,
    verticalOffset: opts.verticalOffset ?? 0.0,
  };
  // Injected samplers (plants plan F5): a host with its own streamed terrain hands in TSL Fns
  // taking (x, z) SCALARS in the same frame the candidates are generated in, and does its own
  // render-local/global conversion. Both are optional; omitted, nothing below changes.
  const injectedHeight = opts.heightNode ?? null;
  const injectedDensity = opts.densityNode ?? null;
  if (injectedHeight && typeof injectedHeight !== 'function') throw new TypeError('grass heightNode must be a TSL node function');
  if (injectedDensity && typeof injectedDensity !== 'function') throw new TypeError('grass densityNode must be a TSL node function');
  // Ground colour under the blade, Fn(([x, z, y]) => vec3). Evaluated once per blade in the cull
  // and packed into the instance record's three spare floats, not recomputed per vertex.
  const injectedGround = opts.groundColorNode ?? null;
  if (injectedGround && typeof injectedGround !== 'function') throw new TypeError('grass groundColorNode must be a TSL node function');
  const hasHeightTex = !injectedHeight && !!(opts.heightTex && opts.heightTexBounds);
  const heightTex = hasHeightTex ? opts.heightTex : null;
  const hasDensityTex = !injectedDensity && !!(opts.densityTex && opts.densityTexBounds);
  const densityTex = hasDensityTex ? opts.densityTex : null;
  const uBoundsMinX = hasHeightTex ? uniform(opts.heightTexBounds.minX) : null;
  const uBoundsMinZ = hasHeightTex ? uniform(opts.heightTexBounds.minZ) : null;
  const uBoundsW = hasHeightTex ? uniform(opts.heightTexBounds.worldX) : null;
  const uBoundsH = hasHeightTex ? uniform(opts.heightTexBounds.worldZ) : null;
  const uDensityMinX = hasDensityTex ? uniform(opts.densityTexBounds.minX) : null;
  const uDensityMinZ = hasDensityTex ? uniform(opts.densityTexBounds.minZ) : null;
  const uDensityW = hasDensityTex ? uniform(opts.densityTexBounds.worldX) : null;
  const uDensityH = hasDensityTex ? uniform(opts.densityTexBounds.worldZ) : null;
  const half0 = Math.ceil(o.radius / cellSize) | 0;

  // ---- anchor mode setup (authored maps; see header) ----
  const surfacePositions = opts.surfaceGeometry?.attributes?.position?.array ?? null;
  const anchorMode = !!surfacePositions;
  const chunkSize = opts.anchorChunkSize ?? 32;
  // Anchors are sampled at the creation-time density; the density slider then thins
  // them via uDensityScale (values above the sampled base have no effect).
  const baseDensity = o.density;
  const perSlot = anchorMode ? Math.max(1, Math.round(baseDensity * chunkSize * chunkSize)) : 0;
  const numSlots = anchorMode ? slotCapacityForRadius(maxRadius, chunkSize) : 0;
  const anchorCap = numSlots * perSlot;
  const chunkIndex = anchorMode
    ? buildChunkIndex(surfacePositions, { chunkSize, minNormalY: opts.anchorMinNormalY ?? 0.5 })
    : null;

  // Worst-case survivor capacity. Procedural mode can fill every window slot; anchor
  // mode is additionally capped by maxBlades (the indirect draw is clamped to it
  // anyway), which keeps the instance buffer far smaller than the anchor pool.
  // Worst case is every cell in the window full, which no real scene reaches once the cull
  // gradient thins the edge. A host may cap it; the uHardCap guard turns an overflow into a
  // truncated field instead of an out-of-bounds write.
  const CAP = anchorMode
    ? (o.maxBlades > 0 ? Math.min(anchorCap, o.maxBlades) : anchorCap)
    : Math.max(1, Math.floor(Math.min(maxInstances(maxRadius, cellSize, Kmax), opts.maxInstances ?? Infinity)));
  if (anchorMode) {
    console.info(`[grass] anchor mode: ${chunkIndex.chunks.size} surface chunks, `
      + `${numSlots} slots × ${perSlot} anchors `
      + `(${(anchorCap * 16 / 1e6).toFixed(0)} MB anchors + ${(CAP * 32 / 1e6).toFixed(0)} MB instances)`);
  }

  // ---- buffers (GPU-resident; only anchor-slot ranges are re-uploaded, on streaming) ----
  // per instance: 2x vec4 → [2i]=(x,y,z,h), [2i+1]=(yaw,_,_,_)
  const instAttr = new StorageInstancedBufferAttribute(new Float32Array(CAP * 8), 8);
  const inst = storage(instAttr, 'vec4', CAP * 2);
  // [survivors, planar/fade, density, ground/water, view, depth occlusion, capacity overflow,
  // tier 0 survivors, tier 1 survivors, tier 2 survivors]. Anchor mode counts in [0]; the
  // procedural cull counts per tier (2026-09-06, tiered recull) so one tier can recull alone.
  // Rejection counters are opt-in: their atomics are useful diagnostics but are not free.
  const TIERS = 3;
  const counterAttr = new StorageBufferAttribute(new Uint32Array(7 + TIERS), 1);
  const counter = storage(counterAttr, 'uint', 7 + TIERS).toAtomic();
  // One indirect draw per tier over that tier's region of the instance buffer.
  const indirectAttrs = Array.from({ length: TIERS }, () => new IndirectStorageBufferAttribute(new Uint32Array([9, 0, 0, 0, 0]), 5));
  const indirects = indirectAttrs.map(a => storage(a, 'uint', 5));
  const indirectAttr = indirectAttrs[0], indirect = indirects[0];
  // anchor mode: (x,y,z,rand01) per anchor, chunk-slot-strided + live count per slot
  const anchorArray = anchorMode ? new Float32Array(anchorCap * 4) : null;
  const anchorAttr = anchorMode ? new StorageBufferAttribute(anchorArray, 4) : null;
  const anchorsBuf = anchorMode ? storage(anchorAttr, 'vec4', anchorCap) : null;
  const slotCountArray = anchorMode ? new Uint32Array(numSlots) : null;
  const slotCountAttr = anchorMode ? new StorageBufferAttribute(slotCountArray, 1) : null;
  const slotCounts = anchorMode ? storage(slotCountAttr, 'uint', numSlots) : null;

  // ---- uniforms (live) ----
  const uCam      = uniform(new THREE.Vector2());
  const uDiagnostics = uniform(0);
  // View cone in XZ, same law as plants-gpu.js: a blade survives inside the camera's horizontal
  // field of view plus a margin, or within nearKeep of it. uCosHalf -1 keeps everything (looking
  // nearly straight down, or a camera without fov). Rotation re-runs the cull like a cell change.
  let frustumCull = opts.frustumCull ?? true;
  const uFwd = uniform(new THREE.Vector2(1, 0));
  const uCosHalf = uniform(-1);
  const uNearKeep = uniform(opts.nearKeep ?? 6);
  const _dir = new THREE.Vector3();
  const coneScratch = { fx: 1, fz: 0, cos: -1 };
  let lastFx = NaN, lastFz = NaN, lastCos = NaN;
  function coneFor() {
    coneScratch.fx = 1; coneScratch.fz = 0; coneScratch.cos = -1;
    if (!frustumCull || !(camera.fov > 0)) return coneScratch;
    camera.getWorldDirection(_dir);
    const hl = Math.hypot(_dir.x, _dir.z);
    if (hl < 0.35) return coneScratch;
    const halfV = (camera.fov * Math.PI / 180) / 2, halfH = Math.atan(Math.tan(halfV) * (camera.aspect || 1));
    const denom = hl - Math.tan(halfV) * Math.sqrt(Math.max(0, 1 - hl * hl));
    if (denom < 0.2) return coneScratch;
    // Quantised so a turning camera re-culls every ~6 degrees, not every frame: the 0.22 rad
    // margin above is wider than one step, so the cone stays conservative between reculls.
    const STEP = 0.1;
    const half = Math.min(Math.PI, Math.ceil((Math.atan(Math.tan(halfH) / denom) + 0.22) / STEP) * STEP);
    const yaw = Math.round(Math.atan2(_dir.z, _dir.x) / STEP) * STEP;
    coneScratch.fx = Math.cos(yaw); coneScratch.fz = Math.sin(yaw); coneScratch.cos = Math.cos(half);
    return coneScratch;
  }
  // Occlusion against flora-occlusion.js's depth image: project the candidate with the same
  // view-projection, read the stored view depth at the point and its four neighbours, and drop
  // it when it is deeper than all of them by more than the bias. Without an occlusion option the
  // test is not compiled in at all.
  const occlusion = opts.occlusion || null;
  // Hi-Z (2026-09-06): a host with a hiz-pyramid.js state gets hiz-test.js's box test against
  // last frame's depth pyramid instead of the depth image; the visibility test is the same.
  const hiz = !occlusion && opts.hiz ? opts.hiz : null;
  const hizSampler = hiz ? createHizSampler(hiz) : null;
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
  const keepFn = occlusion || hizSampler
    ? Fn(([wx, wy, wz, h, dist]) => {
        const visible = bool(true).toVar();
        const keep = bool(true).toVar();
        If(uOccOn.greaterThan(0.5), () => {
          const base = project(wx, wy, wz);
          const top = project(wx, wy.add(h), wz);
          visible.assign(base.onScreen.or(top.onScreen).or(dist.lessThan(1.5)));
          keep.assign(visible);
          // Off-screen points and disabled occlusion need no depth reads. Keep the same five
          // conservative taps and bias for points whose tops actually project into the image.
          If(visible.and(top.onScreen), () => {
            if (occlusion) {
              const uv = vec2(clamp(top.ndc.x.mul(0.5).add(0.5), 0, 1), clamp(float(0.5).sub(top.ndc.y.mul(0.5)), 0, 1));
              const tx = vec2(uOccTexel.x, 0), tz = vec2(0, uOccTexel.y);
              const far = max(max(occTex.sample(uv).r, occTex.sample(uv.add(tx)).r),
                max(occTex.sample(uv.sub(tx)).r, max(occTex.sample(uv.add(tz)).r, occTex.sample(uv.sub(tz)).r)));
              keep.assign(top.w.greaterThan(far.add(uOccBias).add(top.w.mul(0.01))).not());
            } else {
              const half = float(0.05);
              keep.assign(hizSampler.occluded(vec3(wx.sub(half), wy, wz.sub(half)), vec3(wx.add(half), wy.add(h), wz.add(half))).not());
            }
          });
        });
        return vec2(select(visible, float(1), float(0)), select(keep, float(1), float(0)));
      })
    : null;
  let lastOccRevision = -1;
  function syncOcclusion() {
    if (hizSampler) {
      const changed = hizSampler.sync();
      const on = hizSampler.enabled ? 1 : 0;
      const onChanged = uOccOn.value !== on;
      uOccOn.value = on;
      uOccVP.value.copy(hiz.viewProj);
      return changed || onChanged;
    }
    if (!occlusion) return false;
    const on = occlusion.enabled ? 1 : 0;
    const revision = occlusion.revision ?? 0;
    // While disabled, depth image, camera and bias changes cannot affect the shader result.
    // Still cache them so enabling needs one recull, not a second catch-up recull afterward.
    const changed = uOccOn.value !== on || !!on && (!uOccVP.value.equals(occlusion.viewProj)
      || lastOccRevision !== revision || uOccBias.value !== occlusion.bias || !uOccTexel.value.equals(occlusion.texel));
    lastOccRevision = revision;
    uOccOn.value = on;
    uOccVP.value.copy(occlusion.viewProj);
    uOccTexel.value.copy(occlusion.texel);
    uOccBias.value = occlusion.bias;
    return changed;
  }
  const inConeFn = (wx, wz, dist) => {
    const rel = vec2(wx.sub(uCam.x), wz.sub(uCam.y));
    return dist.lessThan(uNearKeep).or(dot(rel.div(dist.max(0.001)), uFwd).greaterThan(uCosHalf));
  };
  const uRadius   = uniform(o.radius);
  const uCullStart = uniform(o.cullStart !== null ? o.cullStart : o.radius * 0.8);
  // The distance fade, in pieces. Keep probability is 1 up to cullStart (the fade start), then
  // falls as edge^fadeCurve to 0 at fadeEnd; the material tapers height and width over the same
  // band by fadeHeight/fadeWidth (0 = the coin flip alone, the old look), tints toward the ground
  // over its own band, and shrinks blades nearer than nearFadeEnd (0 = off). One slider used to
  // drive all of it.
  const uFadeEnd = uniform(o.radius);
  const uFadeCurve = uniform(Math.max(0.01, o.fadeCurve));
  const uFadeHeight = uniform(Math.max(0, Math.min(1, o.fadeHeight)));
  const uFadeWidth = uniform(Math.max(0, Math.min(1, o.fadeWidth)));
  const uTintFadeStart = uniform(0), uTintFadeEnd = uniform(1);
  const uNearFadeStart = uniform(Math.max(0, o.nearFadeStart));
  const uNearFadeEnd = uniform(Math.max(0, o.nearFadeEnd));
  // The bands that follow the radius and the fade start, resolved whenever either moves.
  function syncFadeBands() {
    const start = uCullStart.value;
    const end = o.fadeEnd !== null ? Math.max(start, Math.min(o.fadeEnd, uRadius.value)) : uRadius.value;
    uFadeEnd.value = end;
    uTintFadeStart.value = o.tintFadeStart !== null ? Math.max(0, o.tintFadeStart) : start;
    uTintFadeEnd.value = o.tintFadeEnd !== null ? Math.max(uTintFadeStart.value, o.tintFadeEnd) : end;
  }
  syncFadeBands();
  // Keep-probability edge; grass-cells.fadeEdge is the JS twin.
  const fadeEdgeFn = (dist) => {
    const band = uFadeEnd.sub(uCullStart).max(float(0.001));
    return pow(clamp(dist.sub(uCullStart).div(band), 0, 1), uFadeCurve);
  };
  const uMaxBlades = uniform(o.maxBlades, 'uint');
  const uHalf     = uniform(half0);
  const uSide     = uniform(2 * half0 + 1);
  const uPerCell  = uniform(perCellCount(o.density, cellSize, Kmax));
  // Threads a recull may dispatch. The buffer already truncates; without this the DISPATCH still
  // grows as radius^2 x density, and the far corner of the two sliders is tens of millions of
  // threads -- a hang rather than a degraded frame. Thinning is visible in stats, never silent.
  let dispatchBudget = Math.max(1, opts.dispatchBudget ?? 8e6);
  let requestedPerCell = perCellCount(o.density, cellSize, Kmax);
  // Distance tiers (procedural mode): [{ radius, density }], density a fraction of the base and
  // radius where the tier ends (the last runs to the window edge). One tier at 1 is the old field.
  let tierSpec = normaliseTiers(opts.tiers);
  const uTierThreads0 = uniform(0, 'int'), uTierThreads1 = uniform(0, 'int');
  const uTierCells0 = uniform(0, 'int'), uTierCells1 = uniform(0, 'int');
  const uTierPerCell0 = uniform(0, 'int'), uTierPerCell1 = uniform(0, 'int'), uTierPerCell2 = uniform(0, 'int');
  let totalThreads = 0;
  const uCellSize = uniform(cellSize);
  // Cell indices are render-local, so a floating-origin rebase used to shift every hash input and
  // re-roll the whole field in one frame. Placement hashes add this back to get a GLOBAL cell.
  const uCellOriginX = uniform(0, 'int');
  const uCellOriginZ = uniform(0, 'int');
  // Same problem for anything sampled at a world position in the material: wind phase, cloud
  // shadow, coverage. This is the render origin in metres.
  // Render-only, camera/clock-derived, shared by the tier meshes: one upload per pass, not one per mesh.
  const uWorldOrigin = uniform(new THREE.Vector2()).setGroup(renderGroup);
  const uWaterMin = uniform(o.waterLevel + o.shoreMargin);
  const uDensityScale = uniform(1);            // anchor mode: live density / sampled base
  const uHardCap = uniform(CAP, 'uint');       // instance-buffer capacity (write + draw clamp)
  // Tiered recull: the thread the dispatch starts at, the reset mask, and each tier's region.
  const uTierBegin = uniform(0, 'int');
  const uResetTiers = uniform(7, 'uint');
  const uRegionBase = [uniform(0, 'uint'), uniform(0, 'uint'), uniform(0, 'uint')];
  const uRegionSize = [uniform(CAP, 'uint'), uniform(0, 'uint'), uniform(0, 'uint')];
  let tierThreads = [0, 0, 0], regions = tierRegions({ threads: [CAP] }, CAP);
  // Per-tier recull clocks ({ move, turn, frames }); see grass-cells.tierDue.
  let tierClocks = normaliseTierClocks(opts.tierClocks);
  const tierLast = [null, null, null];
  let frameNo = 0;
  let meshes = [];   // filled once the meshes exist; syncPerCell runs before that
  const uBaseAmp  = uniform(o.baseAmp);
  const uLake     = uniform(o.lake);
  const uLakeDepth= uniform(o.lakeDepth);
  const uTime     = uniform(0).setGroup(renderGroup);
  const uWindSpeed= uniform(2.0);
  const uWindFreq = uniform(0.3);    // wind wave spatial freq per world unit (seam-free)
  const uTipDist  = uniform(0.3);
  const uCenterDist = uniform(0.1);
  const uBladeHeight = uniform(o.bladeHeight);
  const uBladeWidth = uniform(o.bladeWidth);
  const uVerticalOffset = uniform(o.verticalOffset);
  // How far a blade reads as the ground it stands on: at the root, and at the draw edge.
  const uGroundTint = uniform(injectedGround ? (opts.groundTint ?? 0.5) : 0);
  const uGroundTintFar = uniform(opts.groundTintFar ?? 1);
  const uGroundTintReach = uniform(opts.groundTintReach ?? 0.35);
  // Terrain extent: grass is rejected outside these XZ bounds. Defaults to ±1e9 (effectively
  // infinite) for procedural terrain; set to the map's world bounds for authored maps so blades
  // don't scatter beyond the mesh edge.
  const uTerrainMinX = uniform(hasHeightTex ? opts.heightTexBounds.minX : -1e9);
  const uTerrainMaxX = uniform(hasHeightTex ? opts.heightTexBounds.minX + opts.heightTexBounds.worldX : 1e9);
  const uTerrainMinZ = uniform(hasHeightTex ? opts.heightTexBounds.minZ : -1e9);
  const uTerrainMaxZ = uniform(hasHeightTex ? opts.heightTexBounds.minZ + opts.heightTexBounds.worldZ : 1e9);
  let dirty = true;
  let lastCellX = null;
  let lastCellZ = null;
  const stats = {
    recullMode,
    anchorMode,
    capacity: CAP,          // instance-buffer size; the live count lives in the indirect buffer
    dispatch: 0,            // threads the last recull actually ran
    dispatchClamped: false, // the thread budget thinned the field below what density asked for
    perCell: 0,
    perCellRequested: 0,
    density: 0,
    requestedDensity: 0,
    maxDensity: Kmax / (cellSize * cellSize),
    residentChunks: 0,
    reculls: 0,
    skippedReculls: 0,
    lastCell: '',
    dirty: true,
    dirtyReason: 'build',
    lastRecull: '',       // what triggered the last recull: dirty:<reason>, cell, cone, occlusion or tiers a-b
    tierReculls: [0, 0, 0],   // reculls that covered each tier
    tierThreads: [0, 0, 0],   // candidate threads per tier
  };
  const markDirty = (reason = 'set') => {
    dirty = true;
    stats.dirty = true;
    stats.dirtyReason = reason;   // who asked, for the panel's recull readout
  };
  // Blades per cell actually used, per tier: what density asks for, thinned to fit the thread
  // budget from the outer tier inward. Slots are hashed independently, so thinning drops the high
  // slots and leaves the rest where they are. The thread layout (grass-cells.tierLayout) is the
  // cumulative cell and thread count at each tier's end, which the kernel inverts.
  function syncPerCell() {
    const half = Math.max(0, uHalf.value);
    const asked = tierSpec.map(t => ({
      ring: Number.isFinite(t.radius) ? Math.ceil(t.radius / cellSize) : half,
      perCell: perCellCount(o.density * t.density, cellSize, Kmax),
    }));
    const thinned = thinTiers(half, asked, dispatchBudget);
    const lay = tierLayout(half, thinned);
    const last = lay.threads.length - 1;
    const next = {
      t0: lay.threads[0], t1: lay.threads[1] ?? lay.threads[0],
      c0: lay.cells[0], c1: lay.cells[1] ?? lay.cells[0],
      p0: lay.perCell[0], p1: lay.perCell[1] ?? 0, p2: lay.perCell[2] ?? 0,
    };
    const changed = uTierThreads0.value !== next.t0 || uTierThreads1.value !== next.t1
      || uTierCells0.value !== next.c0 || uTierCells1.value !== next.c1
      || uTierPerCell0.value !== next.p0 || uTierPerCell1.value !== next.p1 || uTierPerCell2.value !== next.p2;
    uTierThreads0.value = next.t0; uTierThreads1.value = next.t1;
    uTierCells0.value = next.c0; uTierCells1.value = next.c1;
    uTierPerCell0.value = next.p0; uTierPerCell1.value = next.p1; uTierPerCell2.value = next.p2;
    totalThreads = lay.threads[last];
    requestedPerCell = asked[0].perCell;
    stats.perCellRequested = requestedPerCell;
    stats.perCell = thinned[0].perCell;
    stats.dispatchClamped = thinned.some((t, i) => t.perCell < asked[i].perCell);
    stats.density = thinned[0].perCell / (cellSize * cellSize);
    stats.requestedDensity = requestedPerCell / (cellSize * cellSize);
    stats.tiers = thinned.map((t, i) => ({
      radius: Number.isFinite(tierSpec[i].radius) ? tierSpec[i].radius : uRadius.value,
      density: t.perCell / (cellSize * cellSize), requested: asked[i].perCell / (cellSize * cellSize),
    }));
    tierThreads = [next.t0, next.t1, totalThreads];
    regions = tierRegions({ threads: tierThreads }, CAP);
    for (let t = 0; t < TIERS; t++) {
      uRegionBase[t].value = regions[t].base; uRegionSize[t].value = regions[t].size;
      if (meshes[t]) meshes[t].userData.regionBase = regions[t].base;
    }
    stats.tierThreads = [next.t0, next.t1 - next.t0, totalThreads - next.t1];
    if (uPerCell.value !== thinned[0].perCell) uPerCell.value = thinned[0].perCell;
    if (changed) markDirty('perCell');
  }
  syncPerCell();

  // TSL terrain height: injected by the host, texture path for authored maps, else closed-form.
  const heightFn = injectedHeight ? injectedHeight : hasHeightTex
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

  const densityFn = injectedDensity ? injectedDensity : hasDensityTex
    ? Fn(([x, z]) => {
        const u = clamp(x.sub(uDensityMinX).div(uDensityW), 0, 1);
        const v = clamp(z.sub(uDensityMinZ).div(uDensityH), 0, 1);
        return texture(densityTex, vec2(u, v)).r;
      })
    : Fn(() => float(1));
  // ---- compute kernels (reset → generate+cull → finalize), per the spike ----
  const reset = Fn(() => {
    for (let i = 0; i < 7; i++) atomicStore(counter.element(i), uint(0));
    for (let t = 0; t < TIERS; t++) {
      If(uResetTiers.bitAnd(uint(1 << t)).notEqual(uint(0)), () => { atomicStore(counter.element(7 + t), uint(0)); });
    }
  })().compute(1);
  const diagnosticAdd = index => {
    If(uDiagnostics.greaterThan(0.5), () => { atomicAdd(counter.element(index), uint(1)); });
  };
  const appendBlade = (s, idx, wx, wy, wz, yawFn, heightFn2, groundFn) => {
    const withinCap = s.lessThan(uHardCap)
      .and(uMaxBlades.equal(uint(0)).or(s.lessThan(uMaxBlades)));
    If(withinCap, () => {
      const base2 = s.mul(uint(2));
      const yaw = yawFn();
      const bh = heightFn2();
      const g = groundFn();
      inst.element(base2).assign(vec4(wx, wy, wz, bh));
      inst.element(base2.add(uint(1))).assign(vec4(yaw, g.x, g.y, g.z));
    }).Else(() => { diagnosticAdd(6); });
  };
  // Procedural mode: the survivor lands in its tier's region; `s` counts within the tier.
  const appendBladeAt = (s, base, size, wx, wy, wz, yawFn, heightFn2, groundFn) => {
    If(s.lessThan(size), () => {
      const base2 = base.add(s).mul(uint(2));
      const yaw = yawFn();
      const bh = heightFn2();
      const g = groundFn();
      inst.element(base2).assign(vec4(wx, wy, wz, bh));
      inst.element(base2.add(uint(1))).assign(vec4(yaw, g.x, g.y, g.z));
    }).Else(() => { diagnosticAdd(6); });
  };

  // Anchor-mode cull: each thread owns one anchor-buffer slot entry; live entries
  // (k < slotCounts[chunkSlot]) are distance/edge/water/density tested and appended.
  // Water: a blade below sea level is only rejected when the baked envelope height
  // is ALSO below sea level — i.e. where the water plane actually renders. Cave
  // floors under a high roof keep their grass (no water is drawn there either,
  // since the water mesh is built from the same envelope heightfield).
  const anchorCull = anchorMode ? Fn(() => {
    const idx = int(instanceIndex);
    const slot = idx.div(int(perSlot));
    const k = modInt(idx, int(perSlot));
    If(uint(k).lessThan(slotCounts.element(slot)), () => {
      const a = anchorsBuf.element(idx).toVar();
      const wx = a.x, wy = a.y, wz = a.z;
      const dist = length(vec2(wx.sub(uCam.x), wz.sub(uCam.y)));
      const edge = fadeEdgeFn(dist);
      const keepRand = anchorRandFn(idx, int(7));
      const planarLive = dist.lessThan(uRadius)
        .and(inConeFn(wx, wz, dist))
        .and(keepRand.greaterThan(edge));
      If(planarLive, () => {
        const biomeDensity = densityFn(wx, wz).mul(uDensityScale);
        If(a.w.lessThan(biomeDensity), () => {
          const dry = hasHeightTex
            ? wy.greaterThan(uWaterMin).or(heightFn(wx, wz).greaterThan(uWaterMin))
            : wy.greaterThan(uWaterMin);
          If(dry, () => {
            const visibility = keepFn ? keepFn(wx, wy, wz, uBladeHeight.mul(1.2), dist) : vec2(1, 1);
            If(visibility.x.lessThan(0.5), () => { diagnosticAdd(4); })
              .ElseIf(visibility.y.lessThan(0.5), () => { diagnosticAdd(5); })
              .Else(() => {
                const s = atomicAdd(counter.element(0), uint(1));
                appendBlade(s, idx, wx, wy, wz,
                  () => anchorRandFn(idx, int(3)).mul(6.2831853),
                  () => float(0.8).add(anchorRandFn(idx, int(5)).mul(0.6)),
                  () => injectedGround ? injectedGround(wx, wz, wy) : vec3(0));
              });
          }).Else(() => { diagnosticAdd(3); });
        }).Else(() => { diagnosticAdd(2); });
      }).Else(() => { diagnosticAdd(1); });
    });
  })().compute(anchorCap) : null;

  const proceduralCull = anchorMode ? null : Fn(() => {
    const idx = int(instanceIndex).add(uTierBegin);  // dispatch-relative thread, offset to the first tier reculled
    // Which tier this thread belongs to, and its cell-major index within it.
    const inT0 = idx.lessThan(uTierThreads0), inT1 = idx.lessThan(uTierThreads1);
    const local = select(inT0, idx, select(inT1, idx.sub(uTierThreads0), idx.sub(uTierThreads1)));
    const perCell = select(inT0, uTierPerCell0, select(inT1, uTierPerCell1, uTierPerCell2));
    const cellBase = select(inT0, int(0), select(inT1, uTierCells0, uTierCells1));
    const tierCounter = select(inT0, uint(7), select(inT1, uint(8), uint(9)));
    const regionBase = select(inT0, uRegionBase[0], select(inT1, uRegionBase[1], uRegionBase[2]));
    const regionSize = select(inT0, uRegionSize[0], select(inT1, uRegionSize[1], uRegionSize[2]));
    const K = perCell.max(int(1));                   // live blades per cell; 0 would divide by zero
    const slot = modInt(local, K);
    const cellI = cellBase.add(local.div(K));        // ring-ordered cell index (grass-cells.ringCell)
    const side = int(uSide);
    // Clips the workgroup rounding tail, and the whole dispatch when density is zero.
    If(perCell.greaterThan(int(0)).and(cellI.lessThan(side.mul(side))), () => {
      // Ring k holds cells [(2k-1)^2, (2k+1)^2); the float sqrt is corrected by one either way.
      const k = int(ceil(sqrt(cellI.add(int(1)).toFloat()).sub(1).div(2))).toVar();
      const lo = k.mul(int(2)).sub(int(1));
      If(k.greaterThan(int(0)).and(lo.mul(lo).greaterThan(cellI)), () => { k.subAssign(int(1)); });
      const hi = k.mul(int(2)).add(int(1));
      If(hi.mul(hi).lessThanEqual(cellI), () => { k.addAssign(int(1)); });
      const lo2 = k.mul(int(2)).sub(int(1));
      const j = cellI.sub(select(k.greaterThan(int(0)), lo2.mul(lo2), int(0)));
      const L = k.mul(int(2)).max(int(1));
      const sideIdx = j.div(L), t = modInt(j, L);
      // Around the ring: top edge left to right, right edge down, bottom edge right to left, left edge up.
      const ox = select(sideIdx.equal(int(0)), k.negate().add(t),
        select(sideIdx.equal(int(1)), k, select(sideIdx.equal(int(2)), k.sub(t), k.negate())));
      const oz = select(sideIdx.equal(int(0)), k.negate(),
        select(sideIdx.equal(int(1)), k.negate().add(t), select(sideIdx.equal(int(2)), k, k.sub(t))));
      const camGx = int(floor(uCam.x.div(uCellSize)));
      const camGz = int(floor(uCam.y.div(uCellSize)));
      const gx = camGx.add(ox);
      const gz = camGz.add(oz);
      // Positions stay render-local; only the hash inputs are global.
      const hx = gx.add(uCellOriginX), hz = gz.add(uCellOriginZ);
      const jx = slotRandFn(hx, hz, slot, int(1));
      const jz = slotRandFn(hx, hz, slot, int(2));
      const wx = gx.toFloat().mul(uCellSize).add(jx.mul(uCellSize));
      const wz = gz.toFloat().mul(uCellSize).add(jz.mul(uCellSize));
      const dist = length(vec2(wx.sub(uCam.x), wz.sub(uCam.y)));
      const edge = fadeEdgeFn(dist);
      const keepRand = slotRandFn(hx, hz, slot, int(7));
      const densityRand = slotRandFn(hx, hz, slot, int(8));
      const planarLive = wx.greaterThanEqual(uTerrainMinX).and(wx.lessThanEqual(uTerrainMaxX))
        .and(wz.greaterThanEqual(uTerrainMinZ)).and(wz.lessThanEqual(uTerrainMaxZ))
        .and(dist.lessThan(uRadius))
        .and(inConeFn(wx, wz, dist))
        .and(keepRand.greaterThan(edge));
      // Explicit control flow is intentional: a compound predicate can evaluate texture-heavy
      // node expressions before its final If. Keep the exact predicates but stage the work.
      If(planarLive, () => {
        const biomeDensity = densityFn(wx, wz);
        If(densityRand.lessThan(biomeDensity), () => {
          const wy = heightFn(wx, wz);
          If(wy.greaterThan(uWaterMin), () => {
            const visibility = keepFn ? keepFn(wx, wy, wz, uBladeHeight.mul(1.2), dist) : vec2(1, 1);
            If(visibility.x.lessThan(0.5), () => { diagnosticAdd(4); })
              .ElseIf(visibility.y.lessThan(0.5), () => { diagnosticAdd(5); })
              .Else(() => {
                const s = atomicAdd(counter.element(tierCounter), uint(1));
                appendBladeAt(s, regionBase, regionSize, wx, wy, wz,
                  () => slotRandFn(hx, hz, slot, int(3)).mul(6.2831853),
                  () => float(0.8).add(slotRandFn(hx, hz, slot, int(5)).mul(0.6)),
                  () => injectedGround ? injectedGround(wx, wz, wy) : vec3(0));
              });
          }).Else(() => { diagnosticAdd(3); });
        }).Else(() => { diagnosticAdd(2); });
      }).Else(() => { diagnosticAdd(1); });
    });
  })().compute(CAP);

  const cull = anchorMode ? anchorCull : proceduralCull;

  // Ground-colour probe: one thread runs the injected ground node at a point, exactly as the cull
  // packs it into a record, and writes rgb plus the height it stood on for a readback.
  // Two records: (r, g, b, height) and (density, in-cone, keep-edge, water-ok), so a readout can
  // say which test a blade at that point fails, not only what colour it would be.
  const uProbeXZ = uniform(new THREE.Vector2());
  const probeAttr = injectedGround ? new StorageBufferAttribute(new Float32Array(8), 4) : null;
  const probeBuf = probeAttr ? storage(probeAttr, 'vec4', 2) : null;
  const probe = probeAttr ? Fn(() => {
    const wx = uProbeXZ.x, wz = uProbeXZ.y;
    const wy = heightFn(wx, wz);
    const g = injectedGround(wx, wz, wy);
    probeBuf.element(0).assign(vec4(g.x, g.y, g.z, wy));
    const dist = length(vec2(wx.sub(uCam.x), wz.sub(uCam.y)));
    const cone = select(inConeFn(wx, wz, dist), float(1), float(0));
    const water = select(wy.greaterThan(uWaterMin), float(1), float(0));
    probeBuf.element(1).assign(vec4(densityFn(wx, wz), cone, fadeEdgeFn(dist), water));
  })().compute(1) : null;

  const finalize = anchorMode ? Fn(() => {
    const c = atomicLoad(counter.element(0));
    indirect.element(1).assign(c);
    If(c.greaterThan(uHardCap), () => {
      indirect.element(1).assign(uHardCap);
    });
    If(uMaxBlades.greaterThan(uint(0)).and(c.greaterThan(uMaxBlades)), () => {
      indirect.element(1).assign(uMaxBlades);
    });
  })().compute(1) : Fn(() => {
    // Every tier's draw is rewritten from its counter; a tier that did not recull kept its count.
    const remaining = uMaxBlades.toVar();
    for (let t = 0; t < TIERS; t++) {
      const c = min(atomicLoad(counter.element(7 + t)), uRegionSize[t]).toVar();
      If(uMaxBlades.greaterThan(uint(0)), () => {
        c.assign(min(c, remaining));
        remaining.assign(remaining.sub(c));
      });
      indirects[t].element(1).assign(c);
    }
  })().compute(1);

  // ---- instanced base blade + node material ----
  const geom = buildBladeGeometry();
  geom.instanceCount = CAP;
  geom.indirect = indirectAttr;          // exact form per the spike

  const aWind = attribute('aWind', 'float');
  // Each tier's mesh draws its own region; the base comes from mesh.userData so one material
  // (one program) serves all three, the way the forest's slot offset does.
  const recIndex = userData('regionBase', 'uint').add(instanceIndex);
  const rec0 = inst.element(recIndex.mul(uint(2)));        // (x,y,z,h)
  const rec1 = inst.element(recIndex.mul(uint(2)).add(uint(1))); // (yaw,...)
  const base = rec0.xyz, bladeH = rec0.w, yaw = rec1.x;
  const groundColor = rec1.yzw;                       // written by the cull; zero when not injected

  // The fade bands as the material sees them: the keep edge the cull used, the tint ramp, and the
  // near band. Height and width taper over the keep band; the near band shrinks toward the ground.
  const camDist = length(vec2(base.x.sub(uCam.x), base.z.sub(uCam.y)));
  const edgeM = fadeEdgeFn(camDist);
  const tintT = camDist.sub(uTintFadeStart).div(uTintFadeEnd.sub(uTintFadeStart).max(float(0.001))).clamp(0, 1);
  const nearS = camDist.sub(uNearFadeStart).div(uNearFadeEnd.sub(uNearFadeStart).max(float(0.001))).clamp(0, 1);
  const fadeScaleH = float(1).sub(uFadeHeight.mul(edgeM)).mul(nearS);
  const fadeScaleW = float(1).sub(uFadeWidth.mul(edgeM)).mul(nearS);

  // rotate local blade (width axis = local X, blade in XY plane, z=0) by yaw, scale height
  const cy = cos(yaw), sy = sin(yaw);
  const bladeX = positionLocal.x.mul(uBladeWidth).mul(fadeScaleW);
  const rx = bladeX.mul(cy);
  const rz = bladeX.mul(sy);
  const ly = positionLocal.y.mul(bladeH.div(0.8)).mul(uBladeHeight).mul(fadeScaleH);

  // Global, not render-local: a rebase must not jump the wind phase or the cloud shadows.
  const baseWorld = vec2(base.x.add(uWorldOrigin.x), base.z.add(uWorldOrigin.y));
  const worldX = base.x.add(rx);
  const wave = sin(uTime.mul(uWindSpeed).add(worldX.add(uWorldOrigin.x).mul(uWindFreq)));
  const isMidTip = clamp(aWind.mul(2), 0, 1);
  const isTip = clamp(aWind.sub(0.6).mul(10), 0, 1);
  const swayAmp = isMidTip.mul(mix(uCenterDist, uTipDist, isTip));
  // grass-look.js optional features (all default-off; off = the legacy graph exactly)
  const look = createGrassLook(opts.look || {});
  const bladeT = positionLocal.y.div(0.8);            // 0..1 up the base blade (0.8 = its authored height)
  const face = vec2(sy.negate(), cy);                 // horizontal facing, perpendicular to the width axis
  const rnd = look.nodes.bladeRandoms(vec2(yaw.mul(0.31), yaw.mul(0.77).add(baseWorld.x.mul(0.013))));
  const swayXZ = look.nodes.sway({
    worldXZ: baseWorld, legacy: wave, amp: swayAmp, time: uTime, speed: uWindSpeed,
    freq: uWindFreq, phase: rnd.phase,
  });
  const lyKept = ly.mul(look.nodes.coverage(baseWorld));
  const curl = look.nodes.curl({ y: lyKept, t: bladeT, face, curlVar: rnd.curlVar });
  const posNode = vec3(
    worldX.add(swayXZ.x).add(curl.dxz.x),
    base.y.add(uVerticalOffset).add(lyKept).add(curl.dy),
    base.z.add(rz).add(swayXZ.y).add(curl.dxz.y));

  const { noise2D } = buildGrassNoiseFns();
  const uBaseColor = uniform(new THREE.Color(0x16240e));
  const uTipColor  = uniform(new THREE.Color(0x5a8a32));
  const uAmbient = uniform(0.55), uKey = uniform(0.55);
  const uCloudStr = uniform(0.35), uCloudScale = uniform(0.02);
  const cloud = float(1).sub(uCloudStr.mul(noise2D(baseWorld.mul(uCloudScale))));

  const aBladeUV = attribute('aBladeUV', 'vec2');
  const uBladeStyle = uniform(Math.max(0, STYLE_KEYS.indexOf(opts.bladeStyle || 'streaks')), 'float');
  const numStyles = float(STYLE_KEYS.length);
  const atlasUv = vec2(uBladeStyle.add(aBladeUV.x).div(numStyles), aBladeUV.y);
  const styleSample = texture(getGrassStyleAtlas(), atlasUv);
  const fiberMul = float(FIBER_REMAP_MIN).add(styleSample.r.mul(FIBER_REMAP_MAX - FIBER_REMAP_MIN));
  // 0x786028 through THREE.Color, so it is converted to working space like uBaseColor/uTipColor.
  // As a raw vec3 of sRGB bytes it rendered about 2.5x too bright.
  const uDryColor = uniform(new THREE.Color(0x786028));
  const grassColorBase = mix(uBaseColor, uTipColor, aWind).mul(fiberMul);
  const grassColor = mix(grassColorBase, uDryColor, styleSample.g.mul(0.7));
  // Read as the ground the blade stands on: strongest at the root, and total at the far end of
  // the tint ramp, so the field dissolves into the terrain instead of ending on a visible line.
  // Confined to the base, the way grass-look's rootShade does it; a full-length linear ramp left
  // the blade's midpoint half ground-coloured and washed the whole field out.
  const rootW = float(1).sub(smoothstep(float(0), uGroundTintReach.max(float(0.001)), bladeT));
  const tintAmt = uGroundTint.mul(mix(rootW, float(1), tintT.mul(uGroundTintFar))).clamp(0, 1);
  // Colour modes: palette (the tint sliders decide), ground (tint 1 everywhere), proof (the raw
  // ground sample with the ground's normal and nothing else, so a blade should vanish into the
  // terrain and any blade you can still pick out is a sampling error).
  const uColorMode = uniform(Math.max(0, COLOR_MODES.indexOf(opts.colorMode || 'palette')), 'float');
  const groundOnly = clamp(uColorMode, 0, 1);
  const proofOnly = clamp(uColorMode.sub(1), 0, 1);
  const tintFinal = injectedGround ? mix(tintAmt, float(1), groundOnly) : float(0);
  // The ground colour is what the terrain already draws, lit by the scene the way the terrain is,
  // so the flat key/ambient factor, the cloud noise and the root shade belong to the palette side
  // alone. Mixed AFTER them: at tint 1 a blade is the ground colour exactly. They used to multiply
  // the blend, which left the ground part 10 % too bright and blotchy.
  const paletteLit = grassColor.mul(uAmbient.add(uKey)).mul(cloud).mul(look.nodes.rootShade(bladeT));
  const colorNode = mix(paletteLit, groundColor, tintFinal);

  // Two materials over one graph: standard (PBR, the original) and Lambert, which keeps the light
  // loop and the shadow term but drops the GGX lobe that at roughness 1 was all cost and no look
  // (the same choice grass.js offers as `lighting`). setShading swaps the mesh between them.
  const mats = {
    standard: new MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 1, metalness: 0 }),
    lambert: new MeshLambertNodeMaterial({ side: THREE.DoubleSide }),
  };
  // grass-look's normal is view space (65 % blade face by default); a ground-coloured blade moves
  // it toward the ground's up by the same amount, or it lights differently per yaw than the ground.
  const upView = cameraViewMatrix.transformDirection(vec3(0, 1, 0));
  const normalNode = normalize(mix(curl.normal, upView, tintFinal));
  // SP4a: optional additive clustered point-light term. Sample at the blade's ground-planted
  // BASE (not the swaying elevated tip) so grass lighting stays locked to the terrain pool
  // directly beneath it — avoids height-parallax desync as lights move.
  const backlight = look.nodes.translucency({ t: bladeT, worldPos: positionWorld, tipColor: uTipColor });
  const emissive = opts.addEmissive ? opts.addEmissive(base, vec3(0, 1, 0)).add(backlight) : backlight;
  for (const m of Object.values(mats)) {
    m.positionNode = posNode;
    m.colorNode = colorNode;
    m.normalNode = normalNode;
    m.emissiveNode = emissive.mul(float(1).sub(proofOnly));
  }
  const mat = mats[opts.shading] ?? mats.standard;

  const mesh = new THREE.Mesh(geom, mat);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.userData.regionBase = 0;
  // Tiers 1 and 2 draw as children of the tier-0 mesh, so a host that adds `mesh` gets all three.
  meshes.push(mesh);
  if (!anchorMode) {
    for (let t = 1; t < TIERS; t++) {
      const g = geom.clone();
      g.instanceCount = CAP;
      g.indirect = indirectAttrs[t];
      const m = new THREE.Mesh(g, mat);
      m.frustumCulled = false; m.castShadow = false; m.receiveShadow = true;
      m.userData.regionBase = regions[t].base;
      m.name = `grass-tier-${t}`;
      mesh.add(m);
      meshes.push(m);
    }
  }

  // ---- anchor streaming: keep chunks near the camera resident in slot pool ----
  // Admits nearest-first within a per-frame CPU budget; evicts with one chunk of
  // hysteresis so the boundary doesn't thrash. Sampling is deterministic per chunk
  // key, so a chunk that leaves and re-enters gets identical blades.
  const resident = anchorMode ? new Map() : null;   // chunkKey -> slot index
  const freeSlots = anchorMode ? Array.from({ length: numSlots }, (_, i) => numSlots - 1 - i) : null;
  const anchorBudgetMs = opts.anchorBudgetMs ?? 3;
  const ANCHOR_SEED = 0x51ab77;
  function maintainResidency() {
    const camX = camera.position.x, camZ = camera.position.z;
    const r = uRadius.value;
    let changed = false;
    let countsChanged = false;
    for (const [key, slot] of resident) {
      const [cx, cz] = parseChunkKey(key);
      if (pointToChunkDist(camX, camZ, cx, cz, chunkSize) > r + chunkSize) {
        resident.delete(key);
        freeSlots.push(slot);
        slotCountArray[slot] = 0;
        countsChanged = true;
        changed = true;
      }
    }
    const minCx = Math.floor((camX - r) / chunkSize), maxCx = Math.floor((camX + r) / chunkSize);
    const minCz = Math.floor((camZ - r) / chunkSize), maxCz = Math.floor((camZ + r) / chunkSize);
    const missing = [];
    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const key = chunkKey(cx, cz);
        if (resident.has(key) || !chunkIndex.chunks.has(key)) continue;
        const d = pointToChunkDist(camX, camZ, cx, cz, chunkSize);
        if (d <= r) missing.push([d, key]);
      }
    }
    if (missing.length) {
      missing.sort((a, b) => a[0] - b[0]);
      const t0 = performance.now();
      let uploaded = false;
      for (const [, key] of missing) {
        if (performance.now() - t0 > anchorBudgetMs) break;
        const slot = freeSlots.pop();
        if (slot === undefined) break;                // pool exhausted; retry as chunks evict
        const data = sampleChunk(chunkIndex, surfacePositions, key, {
          density: baseDensity, maxCount: perSlot, seed: ANCHOR_SEED,
        }) ?? new Float32Array(0);
        const n = data.length / 4;
        if (n > 0) {
          anchorArray.set(data, slot * perSlot * 4);
          anchorAttr.addUpdateRange(slot * perSlot * 4, n * 4);
          uploaded = true;
        }
        slotCountArray[slot] = n;
        countsChanged = true;
        resident.set(key, slot);
        changed = true;
      }
      if (uploaded) anchorAttr.needsUpdate = true;
    }
    if (countsChanged) slotCountAttr.needsUpdate = true;
    if (changed) markDirty('anchors');
    stats.residentChunks = resident.size;
  }

  return {
    mesh,
    // Awaited so the reset→cull→finalize chain is submitted before the frame's draw
    // reads the indirect instanceCount (unawaited fire-and-forget races the draw and
    // makes the grass blink). Mirrors the validated spike's computeAsync ordering.
    async update(seconds) {
      uTime.value = seconds;
      if (anchorMode) maintainResidency();
      const cellX = Math.floor(camera.position.x / cellSize);
      const cellZ = Math.floor(camera.position.z / cellSize);
      const cellChanged = cellX !== lastCellX || cellZ !== lastCellZ;
      if (cellChanged) stats.lastCell = `${cellX}:${cellZ}`;
      const cone = coneFor();
      const coneChanged = cone.fx !== lastFx || cone.fz !== lastFz || cone.cos !== lastCos;
      // Occlusion depends on the exact camera. A depth-image occluder re-culls on any change; a
      // Hi-Z pyramid changes every frame, so each tier decides on its own clock instead.
      const occChanged = syncOcclusion();
      const occOn = hizSampler ? hizSampler.enabled : !!(occlusion && uOccOn.value > 0.5);
      const dirtyAll = recullMode === 'frame' || dirty || cellChanged || coneChanged || (occChanged && !hizSampler);
      frameNo++;
      let first = -1, last = -1;
      if (anchorMode) { if (dirtyAll || occChanged) { first = 0; last = 0; } }
      else {
        // Only a per-frame pyramid runs the clocks; a depth image reculls through dirtyAll when it changes.
        const now = { x: camera.position.x, z: camera.position.z, fx: cone.fx, fz: cone.fz, frame: frameNo, dirty: dirtyAll, occlusion: !!hizSampler && occOn };
        for (let t = 0; t < TIERS; t++) {
          if (stats.tierThreads[t] <= 0 && t > 0) continue;
          if (!tierDue(tierLast[t], now, tierClocks[t])) continue;
          if (first < 0) first = t;
          last = t;
        }
      }
      if (first < 0) {
        stats.skippedReculls++;
        return;
      }
      stats.lastRecull = dirty ? 'dirty:' + stats.dirtyReason : cellChanged ? 'cell' : coneChanged ? 'cone' : occChanged && !hizSampler ? 'occlusion' : `tiers ${first}-${last}`;
      // The dispatch covers the due tiers as one contiguous span of the thread layout; count drives
      // both the dispatch and the shader's own bounds guard, so shrinking the radius or the
      // density shrinks the work instead of discarding it inside the kernel.
      if (!anchorMode) {
        const begin = first > 0 ? tierThreads[first - 1] : 0;
        const end = tierThreads[last];
        uTierBegin.value = begin;
        cull.count = Math.max(1, end - begin);
        stats.dispatch = cull.count;
        let mask = 0;
        for (let t = first; t <= last; t++) mask |= 1 << t;
        uResetTiers.value = mask;
      }
      uCam.value.set(camera.position.x, camera.position.z);
      uFwd.value.set(cone.fx, cone.fz); uCosHalf.value = cone.cos;
      lastFx = cone.fx; lastFz = cone.fz; lastCos = cone.cos;
      await renderer.computeAsync([reset, cull, finalize]);
      for (let t = first; t <= last; t++) {
        tierLast[t] = { x: camera.position.x, z: camera.position.z, fx: cone.fx, fz: cone.fz, frame: frameNo };
        stats.tierReculls[t]++;
      }
      lastCellX = cellX;
      lastCellZ = cellZ;
      dirty = false;
      stats.dirty = false;
      stats.reculls++;
    },
    // Per-tier recull clocks: [{ move (m), turn (deg), frames }] x3, or null for the defaults.
    setTierClocks(spec) {
      tierClocks = normaliseTierClocks(spec);
    },
    get tierClocks() { return tierClocks.map(c => ({ ...c })); },
    // The floating origin moved. Placement hashes and every world-space sample add this back, so
    // the field stays put in the world instead of re-rolling.
    setWorldOrigin(x, z) {
      if (uWorldOrigin.value.x === x && uWorldOrigin.value.y === z) return;
      uWorldOrigin.value.set(x, z);
      uCellOriginX.value = Math.round(x / cellSize);
      uCellOriginZ.value = Math.round(z / cellSize);
      markDirty('setWorldOrigin');
    },
    forceRecull: () => markDirty('forced'),
    stats,
    setDensity(d) {
      if (anchorMode) {
        // thin the sampled anchor pool; values above the sampled base saturate at 1
        const s = Math.max(0, Math.min(1, baseDensity > 0 ? d / baseDensity : 0));
        if (uDensityScale.value === s) return;
        uDensityScale.value = s;
        markDirty('setDensity');
        return;
      }
      o.density = Math.max(0, Number(d) || 0);
      syncPerCell();
    },
    // Distance tiers, [{ radius, density }] with density a fraction of the base; null = one tier.
    setTiers(spec) {
      const next = normaliseTiers(spec);
      if (JSON.stringify(next) === JSON.stringify(tierSpec)) return;
      tierSpec = next;
      syncPerCell();
    },
    get tiers() { return tierSpec.map(t => ({ ...t })); },
    setRadius(r) {
      r = Math.min(r, maxRadius);                       // never exceed the buffer capacity
      const half = Math.ceil(r / cellSize) | 0;
      if (uRadius.value === r && uHalf.value === half && uSide.value === 2 * half + 1) return;
      uRadius.value = r; uHalf.value = half; uSide.value = 2 * half + 1;
      if (o.cullStart === null) uCullStart.value = r * 0.8;
      syncFadeBands();
      syncPerCell();          // a wider window is more cells, so fewer blades each fit the budget
      markDirty('setRadius');
    },
    setCullStart(wu) {
      const v = Math.max(0, Math.min(wu, uRadius.value));
      if (uCullStart.value === v) return;
      o.cullStart = v;
      uCullStart.value = v;
      syncFadeBands();
      markDirty('setCullStart');
    },
    // Where keep probability reaches 0; null follows the radius. Read in the cull, so a recull.
    setFadeEnd(wu) {
      const v = wu === null || wu === undefined ? null : Math.max(0, Number(wu) || 0);
      if (o.fadeEnd === v) return;
      o.fadeEnd = v;
      const before = uFadeEnd.value;
      syncFadeBands();
      if (uFadeEnd.value !== before) markDirty('setFadeEnd');
    },
    setFadeCurve(p) {
      const v = Math.max(0.01, Number(p) || 1);
      if (uFadeCurve.value === v) return;
      uFadeCurve.value = v;
      markDirty('setFadeCurve');
    },
    // Material-side tapers and ramps: live, no recull.
    setFadeHeight(v) { uFadeHeight.value = Math.max(0, Math.min(1, Number(v) || 0)); },
    setFadeWidth(v) { uFadeWidth.value = Math.max(0, Math.min(1, Number(v) || 0)); },
    setTintFade(start, end) {
      o.tintFadeStart = start === null || start === undefined ? null : Math.max(0, Number(start) || 0);
      o.tintFadeEnd = end === null || end === undefined ? null : Math.max(0, Number(end) || 0);
      syncFadeBands();
    },
    setNearFade(start, end) {
      uNearFadeStart.value = Math.max(0, Number(start) || 0);
      uNearFadeEnd.value = Math.max(0, Number(end) || 0);
    },
    get fade() {
      return { start: uCullStart.value, end: uFadeEnd.value, curve: uFadeCurve.value,
        height: uFadeHeight.value, width: uFadeWidth.value,
        tintStart: uTintFadeStart.value, tintEnd: uTintFadeEnd.value,
        nearStart: uNearFadeStart.value, nearEnd: uNearFadeEnd.value };
    },
    // Threads per recull. Raising it buys density at large radius, at whatever your GPU will take.
    setDispatchBudget(n) {
      const v = Math.max(1, Math.floor(Number(n) || 1));
      if (dispatchBudget === v) return;
      dispatchBudget = v;
      syncPerCell();
    },
    get dispatchBudget() { return dispatchBudget; },
    setMaxBlades(n) {
      const v = Math.max(0, n) >>> 0;
      if (uMaxBlades.value === v) return;
      uMaxBlades.value = v;
      markDirty('setMaxBlades');
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
    // No recull: the tint is already in the instance record, these only reweight it.
    setGroundTint(amount, far, reach) {
      if (amount !== undefined && injectedGround) uGroundTint.value = Math.max(0, Math.min(1, Number(amount) || 0));
      if (far !== undefined) uGroundTintFar.value = Math.max(0, Math.min(1, Number(far) || 0));
      if (reach !== undefined) uGroundTintReach.value = Math.max(0.001, Math.min(1, Number(reach) || 0.001));
    },
    get groundTint() {
      return { amount: uGroundTint.value, far: uGroundTintFar.value, reach: uGroundTintReach.value, available: !!injectedGround };
    },
    // 'standard' | 'lambert'; unknown keys are ignored. A material swap, no recull.
    setShading(key) {
      const next = mats[key];
      if (next && mesh.material !== next) mesh.material = next;
    },
    get shading() { return mesh.material === mats.lambert ? 'lambert' : 'standard'; },
    setReceiveShadow(on) {
      const next = !!on;
      if (mesh.receiveShadow === next) return;
      for (const m of meshes) m.receiveShadow = next;
      for (const m of Object.values(mats)) m.needsUpdate = true;
    },
    // The XZ view cone, live: a change moves the cone, which re-culls like a turn does.
    setFrustumCull(on) { frustumCull = !!on; },
    get frustumCull() { return frustumCull; },
    setNearKeep(m) {
      const v = Math.max(0, Number(m) || 0);
      if (uNearKeep.value === v) return;
      uNearKeep.value = v;
      markDirty('setNearKeep');
    },
    // 'palette' | 'ground' | 'proof'; unknown keys are ignored. Live, no recull.
    setColorMode(key) {
      const idx = COLOR_MODES.indexOf(key);
      if (idx >= 0) uColorMode.value = idx;
    },
    get colorMode() { return COLOR_MODES[uColorMode.value] ?? 'palette'; },
    // grass-look.js toggles/amounts; live, no recull. setSunDir takes the world direction TOWARD the sun.
    setLook(partial) { look.set(partial); },
    // Blade colours and the flat light terms, live; the CPU grass takes these as build options.
    setColors(base, tip) { uBaseColor.value.set(base); uTipColor.value.set(tip); },
    setLight(ambient, key) { uAmbient.value = ambient; uKey.value = key; },
    // Blades the last cull kept, read back from the survivor counter. A GPU round trip: for a
    // readout on a timer, never per frame.
    async readBladeCount() {
      const buf = await renderer.getArrayBufferAsync(counterAttr);
      return new Uint32Array(buf)[0];
    },
    setDiagnosticsEnabled(on) {
      const next = on ? 1 : 0;
      if (uDiagnostics.value === next) return;
      uDiagnostics.value = next;
      markDirty('diagnostics');
    },
    async readCullCounts() {
      const v = new Uint32Array(await renderer.getArrayBufferAsync(counterAttr));
      const survivors = anchorMode ? v[0] : v[7] + v[8] + v[9];
      return { survivors, planar: v[1], density: v[2], ground: v[3], view: v[4], occlusion: v[5], overflow: v[6], tiers: [v[7], v[8], v[9]] };
    },
    // The ground colour under a render-local (x, z) as the cull packs it, plus the render-local
    // height it stood on: { r, g, b, y }, or null without an injected ground node. Two GPU round
    // trips; for a readout on a timer.
    async readGroundProbe(x, z) {
      if (!probe) return null;
      uProbeXZ.value.set(x, z);
      await renderer.computeAsync(probe);
      const v = new Float32Array(await renderer.getArrayBufferAsync(probeAttr));
      return { r: v[0], g: v[1], b: v[2], y: v[3], density: v[4], inCone: v[5] > 0.5, edge: v[6], aboveWater: v[7] > 0.5 };
    },
    get hasGroundProbe() { return !!probe; },
    getLook() { return look.get(); },
    setSunDir(v) { look.setSunDir(v); },
    setBladeStyle(key) {
      const idx = STYLE_KEYS.indexOf(key);
      if (idx < 0) return;
      uBladeStyle.value = idx;
    },
    setTerrain(p) {
      let changed = false;
      if (p.baseAmp !== undefined && uBaseAmp.value !== p.baseAmp) { uBaseAmp.value = p.baseAmp; changed = true; }
      if (p.lake !== undefined && uLake.value !== p.lake) { uLake.value = p.lake; changed = true; }
      if (p.lakeDepth !== undefined && uLakeDepth.value !== p.lakeDepth) { uLakeDepth.value = p.lakeDepth; changed = true; }
      if (changed) markDirty('setTerrain');
    },
    setWaterLevel(wl) {
      const waterMin = wl + o.shoreMargin;
      if (uWaterMin.value === waterMin) return;
      uWaterMin.value = waterMin;
      markDirty('setWaterLevel');
    },
    // Storage attributes have no dispose event, and ComputeNode.dispose() frees pipelines and bind
    // groups but not the buffers. Renderer._attributes.delete is the same path the geometry teardown
    // uses (Attributes.delete -> backend.destroyAttribute); private, so it is guarded and optional.
    dispose() {
      for (const node of [reset, cull, finalize, probe]) { try { node?.dispose?.(); } catch { /* already gone */ } }
      const attrs = renderer?._attributes;
      if (attrs?.delete) {
        for (const a of [instAttr, counterAttr, indirectAttr, anchorAttr, slotCountAttr, probeAttr]) {
          if (a) { try { attrs.delete(a); } catch { /* not uploaded, or a build without this internal */ } }
        }
      }
      geom.dispose();
      for (const m of Object.values(mats)) m.dispose();
    },
  };
}
