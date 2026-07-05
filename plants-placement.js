// plants-placement.js -- pure placement logic for understory plants, mirroring
// forest-placement.js's placementRecords shape. Reuses forest-placement.js's rngFrom/hash2
// (identical determinism convention; no reason to duplicate).
import { rngFrom, hash2, valueNoise } from './forest-placement.js';
import { sampleChunk } from './grass-anchors.js';
import { rollPlantVariation } from './plants.js';

const DEFAULT_HUE_VAR = 0.15;

// chunks: forest-placement.js-style chunk descriptors ({key,xMin,zMin,size,...}).
// params: { masterSeed, waterLevel, shoreMargin, plantDensity (plants per world-unit^2),
//           plantSpeciesTable: [{ key, tag: { biomes: string[], density, hueVar? } }, ...],
//           clusterStrength (0..1, default 0), clusterScale (world units per noise cell,
//           default 40), densityAt(x,z) optional authored 0..1 density mask,
//           clumpEnabled (default true -- fable5 GroundCover.ts grassPatch parent/child
//           clumping, the placement DEFAULT; set false to get old flat-uniform positions),
//           clumpChildrenTarget (avg plants per clump, default 6),
//           clumpRadius (world units, default ~chunk.size*0.16),
//           surfaceIndex/surfacePositions optional grass-anchor surface sampler }.
// biomeAt(x,z) (optional): when omitted, every species is a candidate everywhere (matches
// forest-placement.js's convention for procedural/no-biome terrain).
// Returns, per plant: { x, z, y?, scale, yaw, speciesIdx, chunkKey, slot, hue, dryness, age }.
// hue/dryness/age (Phase 1 per-instance variation, plants.js's rollPlantVariation) are drawn
// AFTER the species->scale->yaw sequence below -- never reorder that sequence. Determinism
// contract: same seed + same params always produce the identical output, run to run and
// call to call -- but clumping (clumpEnabled, default true) is on by default and consumes
// its own RNG draws before the per-slot/per-anchor species->scale->yaw->hue sequence runs,
// so output is NOT byte-identical to the pre-clumping era; there is no uniform-scatter
// fallback to fall back to. New draws clumping needs (clump-center generation, and the
// surface-anchor accept/reject below) are always APPENDED after any existing draws for a
// given slot/anchor, never interleaved into the middle of the species->scale->yaw->hue
// sequence, so that sequence itself stays stable relative to itself.
export function plantPlacementRecords(chunks, params, heightAt, biomeAt) {
  const out = [];
  const speciesTable = params.plantSpeciesTable || [];
  if (speciesTable.length === 0) return out;
  const density = Math.max(0, params.plantDensity ?? 0);
  const minBaseY = params.waterLevel + (params.shoreMargin ?? 0.1);
  const clusterStrength = Math.max(0, Math.min(1, params.clusterStrength ?? 0));
  const clusterScale = params.clusterScale ?? 40;
  const densityAt = typeof params.densityAt === 'function' ? params.densityAt : null;
  const waterEnvelopeAt = typeof params.waterEnvelopeAt === 'function' ? params.waterEnvelopeAt : null;
  const clumpEnabled = params.clumpEnabled !== false;
  const clumpChildrenTarget = Math.max(1, params.clumpChildrenTarget ?? 6);
  const clumpRadiusParam = params.clumpRadius;
  const surfaceIndex = params.surfaceIndex || null;
  const surfacePositions = params.surfacePositions || null;
  const surfaceMode = !!(surfaceIndex && surfacePositions);

  // Acceptance probability for a fixed (surface-anchor) point given clump centers: 1 at the
  // nearest center, falling off smoothly with distance/clumpRadius. Same shape as the
  // procedural path's disk sampling (dense near a center, sparse far from all of them),
  // just applied as a gate rather than a position generator.
  function clumpAcceptProb(x, z, centers, radius) {
    let minD2 = Infinity;
    for (const c of centers) {
      const dx = x - c[0], dz = z - c[1];
      const d2 = dx * dx + dz * dz;
      if (d2 < minD2) minD2 = d2;
    }
    const t = Math.sqrt(minD2) / radius;
    return 1 / (1 + t * t);
  }

  function keepCandidate(x, z, y, densityRand, rng) {
    const baseY = y ?? heightAt(x, z);
    if (baseY < minBaseY && (!waterEnvelopeAt || waterEnvelopeAt(x, z) < minBaseY)) return false;
    if (clusterStrength > 0) {
      const n = valueNoise(x / clusterScale, z / clusterScale, params.masterSeed + 4051);
      const acceptProb = 1 - clusterStrength * (1 - n);
      if (rng.next() > acceptProb) return false;
    }
    if (densityAt && densityRand > Math.max(0, Math.min(1, densityAt(x, z)))) return false;
    return true;
  }

  function emitCandidate(x, z, y, chunk, slot, rng, includeY = false) {
    const biome = biomeAt ? biomeAt(x, z) : null;
    const candidates = [];
    for (let i = 0; i < speciesTable.length; i++) {
      const tags = speciesTable[i].tag;
      if (biome === null || !tags.biomes.length || tags.biomes.includes(biome)) candidates.push(i);
    }
    if (candidates.length === 0) return;   // no species valid at this spot -> skip it (unlike
                                           // forest, which falls back to "any species"; plants
                                           // are allowed to be sparse/absent in a biome)
    let total = 0;
    for (const i of candidates) total += Math.max(0, speciesTable[i].tag.density);
    let speciesIdx;
    if (total <= 0) {
      speciesIdx = candidates[Math.floor(rng.next() * candidates.length)];
    } else {
      const r = rng.next() * total;
      let acc = 0; speciesIdx = candidates[candidates.length - 1];
      for (const i of candidates) { acc += Math.max(0, speciesTable[i].tag.density); if (r <= acc) { speciesIdx = i; break; } }
    }
    const scale = 0.85 + rng.next() * 0.3;
    const yaw = rng.next() * Math.PI * 2;
    // Per-instance variation (Phase 1): drawn strictly AFTER species/scale/yaw above, never
    // reordered -- see the determinism note on plantPlacementRecords. hueVar is a per-species
    // knob (plants.js PLANT_BIOME_TAGS); species that omit it get DEFAULT_HUE_VAR.
    const hueVar = speciesTable[speciesIdx].tag.hueVar ?? DEFAULT_HUE_VAR;
    const { hue, dryness, age } = rollPlantVariation(() => rng.next(), hueVar);
    const rec = { x, z, scale, yaw, speciesIdx, chunkKey: chunk.key, slot, hue, dryness, age };
    if (includeY) rec.y = y;
    out.push(rec);
  }

  for (const chunk of chunks) {
    const count = Math.floor(density * chunk.size * chunk.size);
    if (count <= 0) continue;
    const [ix, iz] = chunk.key.split(',').map(Number);
    const crng = rngFrom(Math.floor(hash2(ix, iz, params.masterSeed + 8191) * 0xffffffff));
    // Default structural clumping (fable5 GroundCover.ts grassPatch law): a handful of parent
    // clump centers per chunk. On the procedural path children are GENERATED at sqrt(rng)*radius
    // around a center (area-uniform disk sampling -- NOT rng*radius, which would bunch density
    // toward the center). On the surface-anchor path positions are already fixed by the mesh
    // sampler, so instead each anchor is ACCEPTED/REJECTED with probability derived from its
    // distance to the nearest clump center (clumpAcceptProb below) -- same underlying law
    // (tight near a center, falling off with distance), just expressed as a gate instead of a
    // generator, since the surface path can't relocate a fixed anchor onto a clump. Chunk-local
    // (no cross-chunk neighbor scan) in both cases, so this stays O(n).
    let clumpCenters = null;
    const clumpRadius = Math.max(0.5, clumpRadiusParam ?? chunk.size * 0.16);
    if (clumpEnabled) {
      const nClumps = Math.max(1, Math.round(count / clumpChildrenTarget));
      clumpCenters = new Array(nClumps);
      for (let i = 0; i < nClumps; i++) {
        clumpCenters[i] = [chunk.xMin + crng.next() * chunk.size, chunk.zMin + crng.next() * chunk.size];
      }
    }
    if (surfaceMode) {
      const anchors = sampleChunk(surfaceIndex, surfacePositions, chunk.key, {
        density,
        maxCount: params.surfaceMaxPerChunk ?? count,
        seed: params.surfaceSeed ?? (params.masterSeed + 0x51ab77),
      }) ?? new Float32Array(0);
      for (let slot = 0; slot < anchors.length / 4; slot++) {
        const o = slot * 4;
        const x = anchors[o], y = anchors[o + 1], z = anchors[o + 2], densityRand = anchors[o + 3];
        // Preserve surface-path semantics (authored y, cave/water-envelope dryness) exactly;
        // only the accept/reject test and the clump gate below are new. The clump draw is
        // appended AFTER keepCandidate's own draw (if any), never interleaved into it.
        if (!keepCandidate(x, z, y, densityRand, crng)) continue;
        if (clumpCenters && crng.next() > clumpAcceptProb(x, z, clumpCenters, clumpRadius)) continue;
        emitCandidate(x, z, y, chunk, slot, crng, true);
      }
      continue;
    }
    for (let slot = 0; slot < count; slot++) {
      let x, z;
      if (clumpCenters) {
        const center = clumpCenters[Math.floor(crng.next() * clumpCenters.length)];
        const rr = Math.sqrt(crng.next()) * clumpRadius;
        const aa = crng.next() * Math.PI * 2;
        x = center[0] + Math.cos(aa) * rr;
        z = center[1] + Math.sin(aa) * rr;
        if (x < chunk.xMin || x > chunk.xMin + chunk.size || z < chunk.zMin || z > chunk.zMin + chunk.size) {
          x = chunk.xMin + crng.next() * chunk.size;
          z = chunk.zMin + crng.next() * chunk.size;
        }
      } else {
        x = chunk.xMin + crng.next() * chunk.size;
        z = chunk.zMin + crng.next() * chunk.size;
      }
      // Noise-based clustering: bias acceptance by a smooth low-frequency field so plants
      // clump into patches instead of scattering with flat uniform probability per chunk
      // (the "grid" artifact -- see docs/subsystems/vegetation.md). clusterStrength 0 vs.
      // omitted are byte-identical to EACH OTHER (both skip the noise gate's RNG draw), but
      // neither reproduces pre-clumping-era output: clumpEnabled defaults to true and always
      // consumes its own clump-center draws before this loop runs, for every caller. This is
      // also the extension point for future non-biome terrain masks (water/mountain/snow
      // density fields) -- multiply their [0,1] factors into `n` alongside the noise.
      const densityRand = densityAt ? crng.next() : 0;
      if (!keepCandidate(x, z, null, densityRand, crng)) continue;
      emitCandidate(x, z, null, chunk, slot, crng);
    }
  }
  return out;
}
