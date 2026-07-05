// rocks-placement.js -- pure placement logic for the rock/boulder + scree dressing host
// (merged-plan row #7 / understory-overhaul-plan.md Phase 3), mirroring plants-placement.js's
// record shape and forest-placement.js's determinism convention (rngFrom/hash2 reuse -- same
// RNG family as the rest of the placement stack; per the plan's "do NOT swap RNGs
// mid-overhaul" decision).
//
// Binds to `heightAt` -- the canonical CPU height query (terrainHeight in
// environment-viewer.html), NOT mesh-anchored (R6 resolution in
// docs/understory-overhaul-plan.md): rocks are placed/seated exactly like plants/trees, never
// like GPU grass's mesh-anchored overhang special case.
import { rngFrom, hash2 } from './forest-placement.js';
import { smoothstep, clamp01 } from './moss-tint-ref.js';
import { DEFAULT_MOISTURE } from './moisture-proxy.js';

// lowest of 5 footprint samples so downhill edges never hover on a slope (SeedThree
// rocks.js `seatHeight`).
function seatHeight(heightAt, x, z, footprint) {
  return Math.min(
    heightAt(x, z),
    heightAt(x + footprint, z), heightAt(x - footprint, z),
    heightAt(x, z + footprint), heightAt(x, z - footprint),
  );
}

// rockness = summed weight of the 'gravel'/'rock' terrain layers in the top-4 feathered
// materialWeights returned by surfaceField(x,z) (terrain-loader.js) -- the SurfaceField proxy
// for SeedThree's rocknessAt().
// CONTRACT: indices/weights/layers are PARALLEL arrays -- indices[i] is a *global* layer
// index into TERRAIN_TEXTURE_LAYERS, weights[i] its normalized weight, and layers[i] the
// name at that same slot i. Index `layers` by i, NOT by the global indices[i].
export function rocknessOf(materialWeights) {
  if (!materialWeights) return 0;
  const { indices, weights, layers } = materialWeights;
  if (!indices || !weights || !layers) return 0;
  let r = 0;
  for (let i = 0; i < indices.length; i++) {
    const name = layers[i];
    if (name === 'gravel' || name === 'rock') r += weights[i];
  }
  return clamp01(r);
}

function pickType(types, table, rng) {
  if (types.length === 0) return -1;
  let total = 0;
  for (const i of types) total += Math.max(0, table[i].density ?? 1);
  if (total <= 0) return types[Math.floor(rng.next() * types.length)];
  const r = rng.next() * total;
  let acc = 0, chosen = types[types.length - 1];
  for (const i of types) { acc += Math.max(0, table[i].density ?? 1); if (r <= acc) { chosen = i; break; } }
  return chosen;
}

// params: {
//   masterSeed, waterLevel (default 0),
//   rockTypeTable: [{ key, scree=false, density=1, variantCount=1, sizeRange=[lo,hi],
//                      footprintScale=0.8 }, ...] -- open-ended, any length, zero code
//     changes needed to add types (mirrors forest-placement.js's speciesTable /
//     plants-placement.js's plantSpeciesTable shape).
//   boulderDensity (boulders per world-unit^2; default 0.0006 -- deliberately sparse, like
//     plants-placement.js's plantDensity but far lower), screeDensity (scree per
//     world-unit^2; default 0.03 -- deliberately dense, thousands of instances is the point).
//   rockGateStart/rockGateEnd (default 0.3/0.6): smoothstep ramp on max(slope, rockness)
//     gating SCREE acceptance only -- boulders "scatter broadly" per the work order and are
//     rejected only by water/occupancy, never by this gate.
// }
// opts.trunkQuery(x,z) => truthy if occupied -- OPTIONAL, not hard-wired. When supplied,
// boulder candidates are rejected on occupied ground (for later trunk-collision rejection);
// omit it and boulders place freely except under water.
// surfaceFieldAt(x,z) -- terrain-loader.js's surfaceField (moisture/upness/materialWeights);
// required for scree gating and per-instance moisture, optional for a heightAt-only caller
// (moisture then defaults to DEFAULT_MOISTURE and scree gate defaults to ungated/rejects
// nothing extra).
// Returns, per rock: { x, y, z, scale, yaw, tiltX, tiltZ, variant, variantIdx, moisture,
// scree, chunkKey, slot }.
export function rockPlacementRecords(chunks, params, heightAt, surfaceFieldAt, opts = {}) {
  const out = [];
  const table = params.rockTypeTable || [];
  if (table.length === 0) return out;
  const waterLevel = params.waterLevel ?? 0;
  const boulderDensity = Math.max(0, params.boulderDensity ?? 0.0006);
  const screeDensity = Math.max(0, params.screeDensity ?? 0.03);
  const gateStart = params.rockGateStart ?? 0.3;
  const gateEnd = params.rockGateEnd ?? 0.6;
  const trunkQuery = typeof opts.trunkQuery === 'function' ? opts.trunkQuery
    : (typeof params.trunkQuery === 'function' ? params.trunkQuery : null);

  const boulderTypes = [];
  const screeTypes = [];
  for (let i = 0; i < table.length; i++) (table[i].scree ? screeTypes : boulderTypes).push(i);

  function emit(x, z, chunk, slot, typeIdx, rng, scree) {
    const spec = table[typeIdx];
    const sf = surfaceFieldAt ? surfaceFieldAt(x, z) : null;
    const moisture = sf ? clamp01(sf.moisture ?? DEFAULT_MOISTURE) : DEFAULT_MOISTURE;
    const [lo, hi] = spec.sizeRange || (scree ? [0.05, 0.28] : [0.3, 2.2]);
    const scale = lo + (hi - lo) * rng.next();
    const yaw = rng.next() * Math.PI * 2;
    const tiltRange = scree ? 0.4 : 0.2;
    const tiltX = rng.range(-tiltRange, tiltRange);
    const tiltZ = rng.range(-tiltRange, tiltRange);
    const variantCount = Math.max(1, spec.variantCount ?? 1);
    const variantIdx = variantCount > 1 ? Math.floor(rng.next() * variantCount) : 0;
    const footprintScale = spec.footprintScale ?? 0.8;
    const seatY = seatHeight(heightAt, x, z, scale * footprintScale);
    const y = scree ? seatY - scale * 0.3 : seatY + scale * rng.range(0.0, 0.2);
    out.push({
      x, y, z, scale, yaw, tiltX, tiltZ,
      variant: spec.key ?? typeIdx, variantIdx,
      moisture, scree,
      chunkKey: chunk.key, slot,
    });
  }

  for (const chunk of chunks) {
    const [ix, iz] = chunk.key.split(',').map(Number);
    const crng = rngFrom(Math.floor(hash2(ix, iz, params.masterSeed ?? 1) * 0xffffffff));
    const area = chunk.size * chunk.size;

    // ---- boulders: scatter broadly, rejected only under water / on occupied ground ----
    if (boulderTypes.length) {
      const count = Math.floor(boulderDensity * area);
      for (let slot = 0; slot < count; slot++) {
        const x = chunk.xMin + crng.next() * chunk.size;
        const z = chunk.zMin + crng.next() * chunk.size;
        if (heightAt(x, z) < waterLevel) continue;
        if (trunkQuery && trunkQuery(x, z)) continue;
        const typeIdx = pickType(boulderTypes, table, crng);
        if (typeIdx < 0) continue;
        emit(x, z, chunk, slot, typeIdx, crng, false);
      }
    }

    // ---- scree: dense, hard-gated on slope/rockness ----
    if (screeTypes.length) {
      const count = Math.floor(screeDensity * area);
      for (let slot = 0; slot < count; slot++) {
        const x = chunk.xMin + crng.next() * chunk.size;
        const z = chunk.zMin + crng.next() * chunk.size;
        if (heightAt(x, z) < waterLevel) continue;
        const sf = surfaceFieldAt ? surfaceFieldAt(x, z) : null;
        const slope = sf ? clamp01(1 - (sf.upness ?? 1)) : 0;
        const rockness = sf ? rocknessOf(sf.materialWeights) : 0;
        const gate = Math.max(slope, rockness);
        const acceptProb = smoothstep(gateStart, gateEnd, gate);
        if (crng.next() > acceptProb) continue;
        const typeIdx = pickType(screeTypes, table, crng);
        if (typeIdx < 0) continue;
        emit(x, z, chunk, slot, typeIdx, crng, true);
      }
    }
  }
  return out;
}

// ---- collision integration point (documented, NOT wired) ----
// collision.js's createTrunkIndex(chunkSize) expects, per chunk key, an array of
// `{ x, z, r }` circles via `setTrunks(key, circles)`. Boulders are solid obstacles; scree is
// not ("player collides with boulders, not scree" -- Phase 3 pass/fail criterion). This turns
// placement records into that shape. The actual wiring (grouping these by chunk key and
// calling `trunkIndex.setTrunks(...)` alongside forest trunks in environment-viewer.html) is
// deferred -- see docs/subsystems/rocks.md "Integration".
export function boulderCirclesFromRecords(records, radiusScale = 0.6) {
  return records.filter(r => !r.scree).map(r => ({ x: r.x, z: r.z, r: r.scale * radiusScale }));
}
