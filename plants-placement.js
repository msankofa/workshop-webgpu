// plants-placement.js -- pure placement logic for understory plants, mirroring
// forest-placement.js's placementRecords shape. Reuses forest-placement.js's rngFrom/hash2
// (identical determinism convention; no reason to duplicate).
import { rngFrom, hash2, valueNoise } from './forest-placement.js';
import { sampleChunk } from './grass-anchors.js';

// chunks: forest-placement.js-style chunk descriptors ({key,xMin,zMin,size,...}).
// params: { masterSeed, waterLevel, shoreMargin, plantDensity (plants per world-unit^2),
//           plantSpeciesTable: [{ key, tag: { biomes: string[], density } }, ...],
//           clusterStrength (0..1, default 0), clusterScale (world units per noise cell,
//           default 40), densityAt(x,z) optional authored 0..1 density mask,
//           surfaceIndex/surfacePositions optional grass-anchor surface sampler }.
// biomeAt(x,z) (optional): when omitted, every species is a candidate everywhere (matches
// forest-placement.js's convention for procedural/no-biome terrain).
// Returns, per plant: { x, z, y?, scale, yaw, speciesIdx, chunkKey, slot }.
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
  const surfaceIndex = params.surfaceIndex || null;
  const surfacePositions = params.surfacePositions || null;
  const surfaceMode = !!(surfaceIndex && surfacePositions);

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
    const rec = { x, z, scale, yaw, speciesIdx, chunkKey: chunk.key, slot };
    if (includeY) rec.y = y;
    out.push(rec);
  }

  for (const chunk of chunks) {
    const count = Math.floor(density * chunk.size * chunk.size);
    if (count <= 0) continue;
    const [ix, iz] = chunk.key.split(',').map(Number);
    const crng = rngFrom(Math.floor(hash2(ix, iz, params.masterSeed + 8191) * 0xffffffff));
    if (surfaceMode) {
      const anchors = sampleChunk(surfaceIndex, surfacePositions, chunk.key, {
        density,
        maxCount: params.surfaceMaxPerChunk ?? count,
        seed: params.surfaceSeed ?? (params.masterSeed + 0x51ab77),
      }) ?? new Float32Array(0);
      for (let slot = 0; slot < anchors.length / 4; slot++) {
        const o = slot * 4;
        const x = anchors[o], y = anchors[o + 1], z = anchors[o + 2], densityRand = anchors[o + 3];
        if (!keepCandidate(x, z, y, densityRand, crng)) continue;
        emitCandidate(x, z, y, chunk, slot, crng, true);
      }
      continue;
    }
    for (let slot = 0; slot < count; slot++) {
      const x = chunk.xMin + crng.next() * chunk.size;
      const z = chunk.zMin + crng.next() * chunk.size;
      // Noise-based clustering: bias acceptance by a smooth low-frequency field so plants
      // clump into patches instead of scattering with flat uniform probability per chunk
      // (the "grid" artifact -- see docs/subsystems/vegetation.md). strength 0 reproduces
      // the old uniform behavior exactly, with no extra RNG draw consumed either, so
      // existing callers that omit these params see byte-identical output. This is also
      // the extension point for future non-biome terrain masks (water/mountain/snow
      // density fields) -- multiply their [0,1] factors into `n` alongside the noise.
      const densityRand = densityAt ? crng.next() : 0;
      if (!keepCandidate(x, z, null, densityRand, crng)) continue;
      emitCandidate(x, z, null, chunk, slot, crng);
    }
  }
  return out;
}
