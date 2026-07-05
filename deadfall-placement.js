// deadfall-placement.js -- pure placement logic for fungi/deadfall (merged-plan row #8 /
// understory-overhaul-plan.md Phase 4), mirroring rocks-placement.js's record shape and
// forest-placement.js's determinism convention (rngFrom/hash2 reuse; new RNG draws are appended
// AFTER the existing type->size->yaw sequence, never reordered -- the "do NOT swap RNGs
// mid-overhaul" decision).
//
// Gating (all O(1) surfaceField/heightAt reads, plus a bounded 3x3-chunk canopy lookup -- NO
// global O(trees x deadfall) scan anywhere):
//   - moisture -> decay CLASS (dry->fresh, mid->mossy, wet->rotten)
//   - canopy proximity -> occurrence WEIGHT (deadfall accumulates under trees; open ground is
//     mostly clear). Queried via a chunk-bucketed forest-record index, 3x3 neighbors only.
//   - slope (1-upness) > slopeRejectLogs (~0.5) -> reject LOGS (they'd float/clip); stumps and
//     mushrooms tolerate more slope.
//   - mushrooms cluster (parent/child disk sampling, same law plants use) and gate HARD on
//     moisture x canopy.
// Binds to `heightAt` (canonical terrainHeight), seated at the lowest of 5 footprint samples and
// tilted to the terrain normal (R6 resolution: props bind to terrainHeight, never mesh-anchored).
import { rngFrom, hash2 } from './forest-placement.js';
import { smoothstep, clamp01 } from './moss-tint-ref.js';
import { DEFAULT_MOISTURE } from './moisture-proxy.js';

// lowest of 5 footprint samples so a log/stump's downhill edge never hovers on a slope.
function seatHeight(heightAt, x, z, footprint) {
  return Math.min(
    heightAt(x, z),
    heightAt(x + footprint, z), heightAt(x - footprint, z),
    heightAt(x, z + footprint), heightAt(x, z - footprint),
  );
}

// small terrain-normal tilt from a central-difference height gradient, so props lie along the
// ground. Returns { tiltX, tiltZ } (radians, modest).
//
// dressing-gpu.js's rotateXZY applies Rx(tiltX) then Rz(tiltZ) then Ry(yaw) to LOCAL position/
// normal, in that order. Worked through for a log (local +X axis, the long axis, v=(1,0,0)):
// Rx leaves it unchanged (rotation about the vector's own axis has no effect on the vector
// itself), Rz turns it to (cos tiltZ, sin tiltZ, 0), and Ry then rotates the XZ pair by yaw
// WITHOUT touching the Y component. So the log's rendered long axis is
//   world = (cos(tiltZ)*cos(yaw), sin(tiltZ), -cos(tiltZ)*sin(yaw))
// i.e. its "climb" (world-Y component) is sin(tiltZ) *regardless of yaw*, while its horizontal
// heading is (cos yaw, -sin yaw). tiltZ therefore has to be the terrain slope measured ALONG
// that post-yaw heading (the directional derivative of height along (cos yaw, -sin yaw), i.e.
// dhx*cos(yaw) - dhz*sin(yaw)), not along the raw world-X axis -- otherwise the tilt magnitude
// is right but a yawed log climbs/dips in a direction unrelated to the ground under it. Small-
// angle check: sin(tiltZ) ~ tiltZ must equal that directional derivative, so tiltZ = atan(axisDot)
// (no sign flip -- verified against rotateXZY's exact expansion, not the old yaw=0-only formula).
// tiltX (the roll about the log's own axis) is computed the same way against the perpendicular
// heading, so the cross-section banks with the cross-slope; it doesn't affect the long axis itself.
//
// `yaw` MUST be the instance's already-drawn yaw (passed in, not redrawn) so the deterministic
// RNG draw order in deadfallPlacementRecords/emit() is preserved byte-for-byte.
function tiltToNormal(heightAt, x, z, eps, yaw, maxTilt = 0.5) {
  const dhx = (heightAt(x + eps, z) - heightAt(x - eps, z)) / (2 * eps);
  const dhz = (heightAt(x, z + eps) - heightAt(x, z - eps)) / (2 * eps);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const axisDot = dhx * cy - dhz * sy;   // slope along the yawed long axis (cos yaw, -sin yaw)
  const perpDot = dhx * sy + dhz * cy;   // slope along the perpendicular (roll) direction
  const clampT = (a) => Math.max(-maxTilt, Math.min(maxTilt, a));
  return { tiltX: clampT(Math.atan(perpDot)), tiltZ: clampT(Math.atan(axisDot)) };
}

// ---- canopy index: bucket forest placement records by chunk, query 3x3 neighbors only ----
// forestRecordsByChunk: Map(chunkKey -> records[]) OR a flat records[] with `.chunkKey`. Each
// record needs x,z (forest-placement.js `placementRecords` output already has them). chunkSize:
// the world size of one forest chunk (records' chunk grid cell). Returns { canopyAt(x,z) } where
// canopyAt returns { dist, weight } -- weight in [0,1] rising as you approach a trunk.
// Complexity: O(candidates x trees-in-9-neighbor-chunks) -- bounded, never a global scan.
export function makeCanopyIndex(forestRecordsByChunk, chunkSize, opts = {}) {
  const radius = opts.canopyRadius ?? 9;        // world units: "under canopy" reach of a trunk
  const buckets = new Map();                    // "ix,iz" -> [{x,z}...]
  const inv = 1 / Math.max(1e-6, chunkSize);
  const add = (r) => {
    const ix = Math.floor(r.x * inv), iz = Math.floor(r.z * inv);
    const key = `${ix},${iz}`;
    let arr = buckets.get(key);
    if (!arr) buckets.set(key, (arr = []));
    arr.push(r);
  };
  if (forestRecordsByChunk instanceof Map) {
    for (const recs of forestRecordsByChunk.values()) for (const r of recs) add(r);
  } else if (Array.isArray(forestRecordsByChunk)) {
    for (const r of forestRecordsByChunk) add(r);
  }
  const r2 = radius * radius;
  function canopyAt(x, z) {
    const cx = Math.floor(x * inv), cz = Math.floor(z * inv);
    let best = Infinity;
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gz = cz - 1; gz <= cz + 1; gz++) {
        const arr = buckets.get(`${gx},${gz}`);
        if (!arr) continue;
        for (const r of arr) {
          const dx = r.x - x, dz = r.z - z;
          const d2 = dx * dx + dz * dz;
          if (d2 < best) best = d2;
        }
      }
    }
    const dist = Math.sqrt(best);
    // weight: 1 right at a trunk, smoothly to 0 at `radius`. Beyond radius -> 0 (open ground).
    const weight = best === Infinity ? 0 : 1 - smoothstep(0, r2, best);
    return { dist, weight };
  }
  return { canopyAt, buckets };
}

// moisture -> decay class, with a little RNG jitter around the thresholds so borders aren't hard.
function decayClassFor(moisture, jitter) {
  const m = clamp01(moisture) + (jitter - 0.5) * 0.12;
  if (m < 0.4) return 'fresh';
  if (m < 0.7) return 'mossy';
  return 'rotten';
}

function pickType(indices, table, rng) {
  if (indices.length === 0) return -1;
  let total = 0;
  for (const i of indices) total += Math.max(0, table[i].density ?? 1);
  if (total <= 0) return indices[Math.floor(rng.next() * indices.length)];
  const r = rng.next() * total;
  let acc = 0, chosen = indices[indices.length - 1];
  for (const i of indices) { acc += Math.max(0, table[i].density ?? 1); if (r <= acc) { chosen = i; break; } }
  return chosen;
}

// params: {
//   masterSeed, waterLevel (default 0),
//   deadfallTypeTable: [{ key, kind ('log'|'stump'|'mushroom'), decayClass? ('fresh'|'mossy'|
//       'rotten', logs only), density=1, variantCount=1, sizeRange=[lo,hi], footprintScale=0.7,
//       nominalLength (logs; world length at scale 1, for collision circles, default 4) }, ...]
//     -- open-ended, any length, zero code changes to add types.
//   logDensity   (logs per world-unit^2; default 0.0004 -- sparse)
//   stumpDensity (default 0.0003)
//   mushroomDensity (default 0.02 -- dense but hard-gated, so few survive outside wet canopy)
//   slopeRejectLogs (default 0.5), canopyLogWeight/canopyMushWeight (min occurrence weight floor
//     applied so a little deadfall still appears in the open; defaults 0.15 / 0.0),
//   clumpChildrenTarget (mushrooms per clump, default 4), clumpRadius (default 1.6).
// }
// canopyAt(x,z) -> { weight } from makeCanopyIndex (optional; omitted => weight 1 everywhere, i.e.
//   canopy gating disabled). surfaceFieldAt(x,z) -> terrain-loader.js surfaceField (moisture/
//   upness); optional (moisture defaults to DEFAULT_MOISTURE / moisture-proxy.js, slope 0 when absent).
// Returns, per prop: { x, y, z, scale, yaw, tiltX, tiltZ, extra (=moisture),
//   variant (type key), variantIdx, kind, decayClass, footprintLen (logs), chunkKey, slot }.
export function deadfallPlacementRecords(chunks, params, heightAt, surfaceFieldAt, canopyAt, opts = {}) {
  const out = [];
  const table = params.deadfallTypeTable || [];
  if (table.length === 0) return out;
  const waterLevel = params.waterLevel ?? 0;
  const logDensity = Math.max(0, params.logDensity ?? 0.0004);
  const stumpDensity = Math.max(0, params.stumpDensity ?? 0.0003);
  const mushDensity = Math.max(0, params.mushroomDensity ?? 0.02);
  const slopeRejectLogs = params.slopeRejectLogs ?? 0.5;
  const canopyLogFloor = params.canopyLogWeight ?? 0.15;
  const canopyMushFloor = params.canopyMushWeight ?? 0.0;
  const clumpChildren = Math.max(1, params.clumpChildrenTarget ?? 4);
  const clumpRadius = Math.max(0.4, params.clumpRadius ?? 1.6);
  const canopy = typeof canopyAt === 'function' ? canopyAt : null;

  const logTypes = [], stumpTypes = [], mushTypes = [];
  for (let i = 0; i < table.length; i++) {
    const k = table[i].kind;
    (k === 'stump' ? stumpTypes : k === 'mushroom' ? mushTypes : logTypes).push(i);
  }

  const sf = (x, z) => (surfaceFieldAt ? surfaceFieldAt(x, z) : null);

  function emit(x, z, chunk, slot, typeIdx, rng, kindGroup, extraMeta, field) {
    const spec = table[typeIdx];
    const moisture = field ? clamp01(field.moisture ?? DEFAULT_MOISTURE) : DEFAULT_MOISTURE;
    const [lo, hi] = spec.sizeRange || (kindGroup === 'mushroom' ? [0.7, 1.4] : [0.7, 1.3]);
    const scale = lo + (hi - lo) * rng.next();
    const yaw = rng.next() * Math.PI * 2;
    const footprintScale = spec.footprintScale ?? 0.7;
    const variantCount = Math.max(1, spec.variantCount ?? 1);
    const variantIdx = variantCount > 1 ? Math.floor(rng.next() * variantCount) : 0;
    const footprint = scale * footprintScale;
    const seatY = seatHeight(heightAt, x, z, footprint);
    let tiltX = 0, tiltZ = 0;
    if (kindGroup !== 'mushroom') {
      const tilt = tiltToNormal(heightAt, x, z, Math.max(0.3, footprint), yaw);
      tiltX = tilt.tiltX; tiltZ = tilt.tiltZ;
    }
    const rec = {
      x, y: seatY, z, scale, yaw, tiltX, tiltZ,
      extra: moisture,
      variant: spec.key ?? typeIdx, variantIdx,
      kind: kindGroup, decayClass: extraMeta?.decayClass ?? spec.decayClass ?? null,
      chunkKey: chunk.key, slot,
    };
    if (kindGroup === 'log') rec.footprintLen = scale * (spec.nominalLength ?? 4);
    out.push(rec);
    return rec;
  }

  for (const chunk of chunks) {
    const [ix, iz] = chunk.key.split(',').map(Number);
    const crng = rngFrom(Math.floor(hash2(ix, iz, params.masterSeed ?? 1) * 0xffffffff));
    const area = chunk.size * chunk.size;

    // ---- logs: moisture->decay class, canopy-weighted, slope-rejected ----
    if (logTypes.length) {
      const count = Math.floor(logDensity * area);
      for (let slot = 0; slot < count; slot++) {
        const x = chunk.xMin + crng.next() * chunk.size;
        const z = chunk.zMin + crng.next() * chunk.size;
        if (heightAt(x, z) < waterLevel) continue;
        const field = sf(x, z);
        const slope = field ? clamp01(1 - (field.upness ?? 1)) : 0;
        if (slope > slopeRejectLogs) continue;                 // hard reject on steep ground
        const cw = canopy ? Math.max(canopyLogFloor, canopy(x, z).weight) : 1;
        if (crng.next() > cw) continue;                        // canopy occurrence weight
        const moisture = field ? clamp01(field.moisture ?? DEFAULT_MOISTURE) : DEFAULT_MOISTURE;
        const decayClass = decayClassFor(moisture, crng.next());
        // candidate log types matching this decay class (fallback: any log type)
        let cand = logTypes.filter((i) => (table[i].decayClass ?? decayClass) === decayClass);
        if (cand.length === 0) cand = logTypes;
        const typeIdx = pickType(cand, table, crng);
        if (typeIdx < 0) continue;
        emit(x, z, chunk, slot, typeIdx, crng, 'log', { decayClass }, field);
      }
    }

    // ---- stumps: canopy-weighted, tolerate more slope, no decay-class gating ----
    if (stumpTypes.length) {
      const count = Math.floor(stumpDensity * area);
      for (let slot = 0; slot < count; slot++) {
        const x = chunk.xMin + crng.next() * chunk.size;
        const z = chunk.zMin + crng.next() * chunk.size;
        if (heightAt(x, z) < waterLevel) continue;
        const cw = canopy ? Math.max(canopyLogFloor, canopy(x, z).weight) : 1;
        if (crng.next() > cw) continue;
        const typeIdx = pickType(stumpTypes, table, crng);
        if (typeIdx < 0) continue;
        emit(x, z, chunk, slot + 4096, typeIdx, crng, 'stump', null, sf(x, z));
      }
    }

    // ---- mushrooms: clustered (parent/child), HARD gate on moisture x canopy ----
    if (mushTypes.length) {
      const count = Math.floor(mushDensity * area);
      if (count > 0) {
        const nClumps = Math.max(1, Math.round(count / clumpChildren));
        const centers = [];
        for (let c = 0; c < nClumps; c++) {
          centers.push([chunk.xMin + crng.next() * chunk.size, chunk.zMin + crng.next() * chunk.size]);
        }
        for (let slot = 0; slot < count; slot++) {
          const center = centers[Math.floor(crng.next() * centers.length)];
          const rr = Math.sqrt(crng.next()) * clumpRadius;   // area-uniform disk sampling
          const aa = crng.next() * Math.PI * 2;
          let x = center[0] + Math.cos(aa) * rr;
          let z = center[1] + Math.sin(aa) * rr;
          if (x < chunk.xMin || x > chunk.xMin + chunk.size || z < chunk.zMin || z > chunk.zMin + chunk.size) {
            x = chunk.xMin + crng.next() * chunk.size;
            z = chunk.zMin + crng.next() * chunk.size;
          }
          if (heightAt(x, z) < waterLevel) continue;
          const field = sf(x, z);
          const moisture = field ? clamp01(field.moisture ?? DEFAULT_MOISTURE) : DEFAULT_MOISTURE;
          const cw = canopy ? Math.max(canopyMushFloor, canopy(x, z).weight) : 1;
          // HARD gate: need BOTH wetness and canopy shade. Product must clear a stochastic bar.
          const gate = smoothstep(0.45, 0.8, moisture) * cw;
          if (crng.next() > gate) continue;
          const typeIdx = pickType(mushTypes, table, crng);
          if (typeIdx < 0) continue;
          emit(x, z, chunk, slot + 8192, typeIdx, crng, 'mushroom', null, field);
        }
      }
    }
  }
  return out;
}

// ---- collision export (documented, NOT wired) ----
// collision.js's createTrunkIndex(chunkSize).setTrunks(key, circles) expects `{ x, z, r }`
// circles. Stumps are single circles; logs approximate as 2-3 circles along their axis (the
// documented approximation). Mushrooms get no collision. Merging these into the trunk index
// alongside forest trunks + boulder circles is the deferred env-viewer step.
export function stumpCirclesFromRecords(records, radiusScale = 0.5) {
  return records.filter((r) => r.kind === 'stump').map((r) => ({ x: r.x, z: r.z, r: r.scale * radiusScale }));
}

// logCirclesFromRecords: 2-3 circles spaced along each log's yaw axis (local +X). `circles` per
// log defaults to 3; radius from footprintLen and a thickness factor.
export function logCirclesFromRecords(records, opts = {}) {
  const nCirc = Math.max(2, opts.circles ?? 3);
  const rFactor = opts.radiusScale ?? 0.18;   // log radius ~ 0.18 * its length is generous
  const out = [];
  for (const r of records) {
    if (r.kind !== 'log') continue;
    const len = r.footprintLen ?? (r.scale * 4);
    const dx = Math.cos(r.yaw), dz = Math.sin(r.yaw);
    const rad = Math.max(0.15, len * rFactor);
    for (let i = 0; i < nCirc; i++) {
      const t = (i / (nCirc - 1) - 0.5) * len; // -len/2 .. +len/2 along axis
      out.push({ x: r.x + dx * t, z: r.z + dz * t, r: rad });
    }
  }
  return out;
}
