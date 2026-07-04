// plants-placement.js -- pure placement logic for understory plants, mirroring
// forest-placement.js's placementRecords shape. Reuses forest-placement.js's rngFrom/hash2
// (identical determinism convention; no reason to duplicate).
import { rngFrom, hash2, valueNoise } from './forest-placement.js';

// chunks: forest-placement.js-style chunk descriptors ({key,xMin,zMin,size,...}).
// params: { masterSeed, waterLevel, shoreMargin, plantDensity (plants per world-unit^2),
//           plantSpeciesTable: [{ key, tag: { biomes: string[], density } }, ...],
//           clusterStrength (0..1, default 0), clusterScale (world units per noise cell,
//           default 40) }.
// biomeAt(x,z) (optional): when omitted, every species is a candidate everywhere (matches
// forest-placement.js's convention for procedural/no-biome terrain).
// Returns, per plant: { x, z, scale, yaw, speciesIdx, chunkKey, slot }.
export function plantPlacementRecords(chunks, params, heightAt, biomeAt) {
  const out = [];
  const speciesTable = params.plantSpeciesTable || [];
  if (speciesTable.length === 0) return out;
  const density = Math.max(0, params.plantDensity ?? 0);
  const minBaseY = params.waterLevel + (params.shoreMargin ?? 0.1);
  const clusterStrength = Math.max(0, Math.min(1, params.clusterStrength ?? 0));
  const clusterScale = params.clusterScale ?? 40;
  for (const chunk of chunks) {
    const count = Math.floor(density * chunk.size * chunk.size);
    if (count <= 0) continue;
    const [ix, iz] = chunk.key.split(',').map(Number);
    const crng = rngFrom(Math.floor(hash2(ix, iz, params.masterSeed + 8191) * 0xffffffff));
    for (let slot = 0; slot < count; slot++) {
      const x = chunk.xMin + crng.next() * chunk.size;
      const z = chunk.zMin + crng.next() * chunk.size;
      if (heightAt(x, z) < minBaseY) continue;
      // Noise-based clustering: bias acceptance by a smooth low-frequency field so plants
      // clump into patches instead of scattering with flat uniform probability per chunk
      // (the "grid" artifact -- see docs/subsystems/vegetation.md). strength 0 reproduces
      // the old uniform behavior exactly, with no extra RNG draw consumed either, so
      // existing callers that omit these params see byte-identical output. This is also
      // the extension point for future non-biome terrain masks (water/mountain/snow
      // density fields) -- multiply their [0,1] factors into `n` alongside the noise.
      if (clusterStrength > 0) {
        const n = valueNoise(x / clusterScale, z / clusterScale, params.masterSeed + 4051);
        const acceptProb = 1 - clusterStrength * (1 - n);
        if (crng.next() > acceptProb) continue;
      }
      const biome = biomeAt ? biomeAt(x, z) : null;
      const candidates = [];
      for (let i = 0; i < speciesTable.length; i++) {
        const tags = speciesTable[i].tag;
        if (biome === null || !tags.biomes.length || tags.biomes.includes(biome)) candidates.push(i);
      }
      if (candidates.length === 0) continue;   // no species valid at this spot -> skip it (unlike
                                                 // forest, which falls back to "any species"; plants
                                                 // are allowed to be sparse/absent in a biome)
      let total = 0;
      for (const i of candidates) total += Math.max(0, speciesTable[i].tag.density);
      let speciesIdx;
      if (total <= 0) {
        speciesIdx = candidates[Math.floor(crng.next() * candidates.length)];
      } else {
        const r = crng.next() * total;
        let acc = 0; speciesIdx = candidates[candidates.length - 1];
        for (const i of candidates) { acc += Math.max(0, speciesTable[i].tag.density); if (r <= acc) { speciesIdx = i; break; } }
      }
      const scale = 0.85 + crng.next() * 0.3;
      const yaw = crng.next() * Math.PI * 2;
      out.push({ x, z, scale, yaw, speciesIdx, chunkKey: chunk.key, slot });
    }
  }
  return out;
}
