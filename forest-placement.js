// forest-placement.js — pure, three-free placement + species logic for the forest.
// Lifted VERBATIM from environment-viewer.html so the GPU palette path (SP6) and the
// future worker path place exactly the trees the main-thread baker does.
//
// Sources (environment-viewer.html): rngFrom :547, hash2 :552, valueNoise :557,
// toOptions/buildSpecies :566-602, sizeFor :669, placementsForChunk :728,
// treeCountForChunk :720, per-tree derivation :857-882.
//
// `placementRecords(chunks, params, heightAt)` returns, per tree:
//   { x, z, scale, yaw, speciesIdx, chunkKey, slot }
// The per-tree RNG stream is consumed in the SAME order as the baker
// (spIdx -> seed -> sizeFor -> yaw) so scale/yaw/species match exactly.

// ---- deterministic RNG (verbatim) ----
export function rngFrom(seed) {
  let s = (seed >>> 0) || 1;
  const next = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, range: (a, b) => a + (b - a) * next() };
}
export function hash2(ix, iz, seed) {
  let h = (Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(seed, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export function valueNoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed), c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---- species taxonomy (verbatim, but hsl -> hex number with no three.js) ----
function hslHex(h, s, l) {
  h = ((h % 1) + 1) % 1; l = Math.min(0.7, Math.max(0.12, l));
  const a = s * Math.min(l, 1 - l);
  const f = n => { const k = (n + h * 12) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  const to = v => Math.round(v * 255);
  return (to(f(0)) << 16) | (to(f(8)) << 8) | to(f(4));
}
function toOptions(t) {
  const a = t.angle;
  return {
    levels: t.levels,
    angle: [0, a, a - 6, a - 10],
    gnarliness: [0.10 * t.gnarl, 0.18 * t.gnarl, 0.28 * t.gnarl, 0.30 * t.gnarl],
    length: [15 * t.slender, 11 * t.slender, 7 * t.slender, 3 * t.slender],
    bark: { color: hslHex(t.barkHue, 0.45, t.barkLight) },
    leaves: { tint: hslHex(t.leafHue, 0.55, t.leafLight), size: t.leafSize, count: 10 },
    force: { direction: [0, 1, 0], strength: 0.03 + t.droop },
  };
}
export function buildSpecies(p, rng) {
  const D = p.diversity, R = () => rng.range(-1, 1);
  const nGenera = Math.max(1, Math.round(p.species - (p.species - 1) * p.generalization));
  const genera = [];
  for (let g = 0; g < nGenera; g++) genera.push({
    barkHue: 0.08 + R() * 0.14 * D, barkLight: 0.32 + R() * 0.10 * D,
    leafHue: 0.28 + R() * 0.16 * D, leafLight: 0.42 + R() * 0.12 * D,
    angle: 55 + R() * 28 * D, gnarl: Math.max(0.2, 1 + R() * 0.8 * D),
    levels: Math.abs(R()) * D > 0.45 ? 4 : 3,
    slender: 1 + R() * 0.5 * D, leafSize: Math.max(0.5, 1.3 * (1 + R() * 0.5 * D)),
    droop: R() * 0.05 * D,
  });
  const out = [], w = D * 0.25;
  for (let s = 0; s < p.species; s++) {
    const G = genera[s % nGenera];
    out.push(toOptions({
      barkHue: G.barkHue + R() * 0.14 * w, barkLight: G.barkLight + R() * 0.10 * w,
      leafHue: G.leafHue + R() * 0.16 * w, leafLight: G.leafLight + R() * 0.12 * w,
      angle: G.angle + R() * 28 * w, gnarl: Math.max(0.2, G.gnarl + R() * 0.8 * w),
      levels: G.levels, slender: Math.max(0.4, G.slender + R() * 0.5 * w),
      leafSize: Math.max(0.5, G.leafSize + R() * 0.5 * w), droop: G.droop + R() * 0.05 * w,
    }));
  }
  return out;
}

// ---- size pipeline (verbatim; THREE.MathUtils.clamp -> inline clamp) ----
// `range` (optional [lo, hi]) lets an authored species override the [0, maxSize] span;
// omitted, this reduces to the original p.maxSize * frac formula exactly.
function sizeFor(p, x, z, rng, range) {
  let v;
  if (p.varPattern === 'noise') v = valueNoise(x * 0.14, z * 0.14, 777);
  else if (p.varPattern === 'gradient') v = clamp((x + 18) / 36, 0, 1);
  else v = rng.next();
  const sv = Math.pow(v, Math.exp(p.skew * 1.5));      // skew>0 biases toward small
  const frac = 1 - p.sizeVar * (1 - sv);               // sizeVar=0 -> all maxSize
  const [lo, hi] = range || [0, p.maxSize];
  return lo + (hi - lo) * Math.max(0.12, frac);
}

// ---- authored Family/Species -> flat species table (tree-viewer.html export) ----
// Each entry is a full trees.js opts object (bark/leaves/force/levels/...) exactly like
// buildSpecies() produces, plus a `_tag` side-channel carrying the placement metadata
// authored per-species in tree-viewer.html's Family/Species tab.
export function buildSpeciesFromFamilies(families) {
  const out = [];
  for (const fam of families) {
    for (const sp of fam.species) {
      out.push({
        ...sp.opts,
        _tag: {
          biomes: sp.biomes || [],
          density: sp.density ?? 1,
          sizeRange: sp.sizeRange || [1, 1],
        },
      });
    }
  }
  return out;
}

// ---- per-chunk tree count (verbatim from treeCountForChunk :720) ----
function treeCountForChunk(chunk, params, targetChunkCount) {
  const [ix, iz] = chunk.key.split(',').map(Number);
  const density = Math.max(0, params.count) / Math.max(1, targetChunkCount);
  const base = Math.floor(density);
  const extra = hash2(ix, iz, params.masterSeed + 31) < density - base ? 1 : 0;
  return base + extra;
}

// ---- per-chunk placement points (verbatim from placementsForChunk :728) ----
function placementsForChunk(chunk, count, params, heightAt) {
  const out = [];
  if (count <= 0) return out;
  const [ix, iz] = chunk.key.split(',').map(Number);
  const crng = rngFrom(Math.floor(hash2(ix, iz, params.masterSeed) * 0xffffffff));
  const minBaseY = params.waterLevel + params.shoreMargin;
  const densityAt = params.treeDensityAt || params.densityAt || null;
  const isDry = ({ x, z }) => heightAt(x, z) >= minBaseY;
  const keepDry = (pt, slot) => {
    if (pt.x < chunk.xMin || pt.x > chunk.xMin + chunk.size || pt.z < chunk.zMin || pt.z > chunk.zMin + chunk.size || !isDry(pt)) return false;
    if (densityAt) {
      const density = clamp(Number(densityAt(pt.x, pt.z)) || 0, 0, 1);
      if (density <= 0) return false;
      const hx = Math.floor(pt.x * 8);
      const hz = Math.floor(pt.z * 8);
      if (hash2(hx, hz, params.masterSeed + slot * 4099) > density) return false;
    }
    pt.id = `${chunk.key}:${slot}`;
    pt.chunkKey = chunk.key;
    pt.slot = slot;
    out.push(pt);
    return true;
  };
  const maxAttempts = Math.max(20, count * 24);
  if (params.placement === 'ring') {
    const rr = chunk.size * 0.32, jitter = chunk.size * 0.08;
    for (let attempt = 0, placed = 0; placed < count && attempt < maxAttempts; attempt++) {
      const i = attempt % Math.max(1, count);
      const a = (i / Math.max(1, count)) * Math.PI * 2 + crng.range(-0.18, 0.18);
      const r = rr + crng.range(-jitter, jitter);
      if (keepDry({ x: chunk.centerX + Math.cos(a) * r, z: chunk.centerZ + Math.sin(a) * r }, placed)) placed++;
    }
  } else if (params.placement === 'clustered') {
    const nc = Math.max(1, Math.round(count / 5)), centers = [];
    const spread = chunk.size * 0.14, margin = spread * 2;
    for (let c = 0; c < nc; c++) centers.push({
      x: crng.range(chunk.xMin + margin, chunk.xMin + chunk.size - margin),
      z: crng.range(chunk.zMin + margin, chunk.zMin + chunk.size - margin),
    });
    for (let attempt = 0, placed = 0; placed < count && attempt < maxAttempts; attempt++) {
      const c = centers[Math.floor(crng.next() * nc)];
      if (keepDry({ x: c.x + crng.range(-spread, spread) + crng.range(-spread, spread), z: c.z + crng.range(-spread, spread) + crng.range(-spread, spread) }, placed)) placed++;
    }
  } else if (params.placement === 'scattered') {
    const cell = Math.max(2, chunk.size / Math.ceil(Math.sqrt(Math.max(1, count) * 1.6))), pts = [];
    let slot = 0;
    for (let gx = chunk.xMin; gx < chunk.xMin + chunk.size; gx += cell) for (let gz = chunk.zMin; gz < chunk.zMin + chunk.size; gz += cell) {
      const x = gx + crng.range(0, cell), z = gz + crng.range(0, cell);
      if (x <= chunk.xMin + chunk.size && z <= chunk.zMin + chunk.size && isDry({ x, z })) pts.push({ x, z, id: `${chunk.key}:${slot}`, chunkKey: chunk.key, slot });
      slot++;
    }
    for (let k = pts.length - 1; k > 0; k--) { const j = Math.floor(crng.next() * (k + 1)); [pts[k], pts[j]] = [pts[j], pts[k]]; }
    out.push(...pts.slice(0, count));
  } else {
    for (let attempt = 0, placed = 0; placed < count && attempt < maxAttempts; attempt++) {
      if (keepDry({ x: crng.range(chunk.xMin, chunk.xMin + chunk.size), z: crng.range(chunk.zMin, chunk.zMin + chunk.size) }, placed)) placed++;
    }
  }
  return out;
}

// ---- public: placement records across all active chunks ----
// `targetChunkCount` defaults to chunks.length (matches the single-window case and the
// live viewer passes terrainSystem.targetChunkCount through params for streaming).
// `biomeAt(x, z)` (optional) is only consulted when `params.speciesTable` (from
// buildSpeciesFromFamilies) is set; without a species table, selection is the original
// uniform-random draw over `params.species`, unaffected by biomeAt.
export function placementRecords(chunks, params, heightAt, biomeAt) {
  const out = [];
  const targetChunkCount = params.targetChunkCount || chunks.length;
  const speciesTable = params.speciesTable || null;
  const speciesCount = speciesTable ? speciesTable.length : Math.max(1, Math.floor(params.species));
  for (const chunk of chunks) {
    const count = treeCountForChunk(chunk, params, targetChunkCount);
    const pts = placementsForChunk(chunk, count, params, heightAt);
    for (const pt of pts) {
      const { x, z, chunkKey, slot } = pt;
      const [tx, tz] = chunkKey.split(',').map(Number);
      const treeRng = rngFrom((Math.floor(hash2(tx, tz, params.masterSeed + slot * 1013) * 0xffffffff) ^ Math.imul(slot + 1, 2654435761)) >>> 0);
      let speciesIdx, sizeRange;
      if (speciesTable) {
        // biome-filtered, density-weighted pick (one RNG draw, same slot as the uniform pick below).
        const biome = biomeAt ? biomeAt(x, z) : null;
        let candidates = [];
        for (let i = 0; i < speciesTable.length; i++) {
          const tags = speciesTable[i]._tag;
          if (biome === null || !tags.biomes.length || tags.biomes.includes(biome)) candidates.push(i);
        }
        if (candidates.length === 0) candidates = speciesTable.map((_, i) => i);   // no match for this biome -> any species
        let total = 0;
        for (const i of candidates) total += Math.max(0, speciesTable[i]._tag.density);
        if (total <= 0) {
          speciesIdx = candidates[Math.floor(treeRng.next() * candidates.length)];
        } else {
          const r = treeRng.next() * total;
          let acc = 0, chosen = candidates[candidates.length - 1];
          for (const i of candidates) { acc += Math.max(0, speciesTable[i]._tag.density); if (r <= acc) { chosen = i; break; } }
          speciesIdx = chosen;
        }
        sizeRange = speciesTable[speciesIdx]._tag.sizeRange;
      } else {
        speciesIdx = Math.floor(treeRng.next() * speciesCount);   // 1st draw
      }
      treeRng.next();                                                 // 2nd draw: tree seed (kept to align the stream with the baker)
      const scale = sizeFor(params, x, z, treeRng, sizeRange);         // 3rd draw (random varPattern)
      const yaw = treeRng.next() * Math.PI * 2;                       // 4th draw
      out.push({ x, z, scale, yaw, speciesIdx, chunkKey, slot });
    }
  }
  return out;
}
