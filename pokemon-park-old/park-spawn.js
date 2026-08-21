// Who is actually standing in the park, and where.

import { rosterFor, pickWeighted, spawnable, SPECIES } from './park-species.js';
import { featureScore, PARK_TREE_DENSITY, makeRng } from './park-biomes.js';

/** How many residents a park of this size wants, and how they are spread. */
export const POPULATION_DEFAULTS = Object.freeze({
  count: 420,
  // Nobody stands within this many metres of anybody else.
  minSpacing: 11,
  // Attempts per resident before giving up on that slot.
  attempts: 40,
  // Nothing spawns this close to the park entrance, so the first thing you see is the park.
  entryClearance: 26,
});

/** Plan the whole park's residents. */
export function planPopulation(parkMap, {
  count = POPULATION_DEFAULTS.count,
  minSpacing = POPULATION_DEFAULTS.minSpacing,
  attempts = POPULATION_DEFAULTS.attempts,
  entryClearance = POPULATION_DEFAULTS.entryClearance,
  entry = { x: 0, z: 0 },
  seed = 1,
  treeDensityAt = null,
  buildingDistanceAt = null,
  waterDistanceAt = null,
} = {}) {
  const rand = makeRng(seed);
  const halfX = parkMap.worldX / 2, halfZ = parkMap.worldZ / 2;
  const residents = [];
  const byBiome = {};
  let misses = 0;

  // Share the census out by how much of the park each biome actually is
  const rosters = {};
  const weights = [];
  for (const z of parkMap.zones) {
    const roster = rosterFor(z.key);
    rosters[z.key] = roster;
    byBiome[z.key] = [];
    // Square-root of the area: a biome twice the size holds more residents but
    weights.push({ key: z.key, w: roster.length ? Math.sqrt(z.share) : 0 });
  }
  const wTotal = weights.reduce((a, b) => a + b.w, 0);
  if (!(wTotal > 0)) return { residents, byBiome, misses: count };

  for (const entryW of weights) {
    const want = Math.round(count * (entryW.w / wTotal));
    const roster = rosters[entryW.key];
    for (let n = 0; n < want; n++) {
      const species = pickWeighted(roster, rand);
      if (!species) { misses++; continue; }
      const placed = placeOne(species, entryW.key);
      if (placed) { residents.push(placed); byBiome[entryW.key].push(placed); }
      else misses++;
    }
  }

  function placeOne(species, biomeKey) {
    for (let a = 0; a < attempts; a++) {
      // Draw from the biome's OWN cells rather than from the park and testing what landed.
      const pt = parkMap.samplePoint(biomeKey, rand);
      if (!pt) return null;
      const x = pt.x, z = pt.z;
      if (Math.abs(x) > halfX * 0.97 || Math.abs(z) > halfZ * 0.97) continue;
      if (Math.hypot(x - entry.x, z - entry.z) < entryClearance) continue;

      const h = parkMap.heightAt(x, z);
      const ctx = {
        height: h,
        waterLevel: parkMap.waterLevel,
        slope: parkMap.slopeAt(x, z),
        treeDensity: treeDensityAt ? treeDensityAt(x, z) : (PARK_TREE_DENSITY[biomeKey] ?? 0),
        buildingDistance: buildingDistanceAt ? buildingDistanceAt(x, z) : 999,
        waterDistance: waterDistanceAt ? waterDistanceAt(x, z) : (biomeKey === 'lake' || biomeKey === 'shore' ? 0 : 999),
        enclosure: biomeKey === 'cave' ? 1 : 0,
      };
      const score = featureScore(species.near, ctx);
      // The score is an acceptance probability, not a threshold.
      if (rand() > 0.25 + 0.75 * score) continue;

      const need = Math.max(minSpacing, species.heightM * 3);
      let clear = true;
      for (const r of residents) {
        const d = Math.hypot(r.x - x, r.z - z);
        if (d < Math.max(need, r.need)) { clear = false; break; }
      }
      if (!clear) continue;

      return {
        id: `${species.key}-${residents.length}`,
        dex: species.dex, key: species.key, species,
        x, z, y: h, yaw: rand() * Math.PI * 2,
        biome: biomeKey, score, need,
      };
    }
    return null;
  }

  return { residents, byBiome, misses };
}

/** Streaming defaults. Distances are metres from the player. */
export const RESIDENCY_DEFAULTS = Object.freeze({
  // Inside this, a resident has a model, a rig and a gait.
  activeRadius: 110,
  // Between active and this, it keeps its model but updates on a stride — the walker's own cheap path.
  farRadius: 190,
  // Beyond this it is a dot on the map and nothing else.
  dropRadius: 230,
  // How many may come in or go out per call.
  maxActivations: 1,
  maxDeactivations: 4,
  hardMax: 46,
});

/** Decide who should exist right now. */
export function createResidency(residents, opts = {}) {
  const o = { ...RESIDENCY_DEFAULTS, ...opts };
  if (!(o.dropRadius > o.farRadius && o.farRadius >= o.activeRadius)) {
    throw new Error('createResidency: radii must satisfy active <= far < drop');
  }
  const active = new Map();

  /** `active` is keyed by resident id and holds whatever the caller stored */
  function update(px, pz) {
    const wantIn = [];
    const wantOut = [];
    const tiers = new Map();

    for (const r of residents) {
      const d = Math.hypot(r.x - px, r.z - pz);
      const live = active.has(r.id);
      if (live) {
        // Drop uses `dropRadius` while entry uses `activeRadius`
        if (d > o.dropRadius) wantOut.push(r);
        else tiers.set(r.id, d <= o.activeRadius ? 0 : 1);
      } else if (d <= o.activeRadius) {
        wantIn.push({ r, d });
      }
    }

    // Nearest first, so walking toward a group populates it from the front rather than at random.
    wantIn.sort((a, b) => a.d - b.d);
    const room = Math.max(0, o.hardMax - active.size + Math.min(wantOut.length, o.maxDeactivations));
    return {
      activate: wantIn.slice(0, Math.min(o.maxActivations, room)).map((e) => e.r),
      deactivate: wantOut.slice(0, o.maxDeactivations),
      tiers,
    };
  }

  return {
    active,
    update,
    get size() { return active.size; },
    options: o,
  };
}

/** A census of the plan, for the field guide panel and for the tests. */
export function censusOf(plan) {
  const bySpecies = new Map();
  for (const r of plan.residents) {
    bySpecies.set(r.key, (bySpecies.get(r.key) || 0) + 1);
  }
  const rows = [...bySpecies.entries()]
    .map(([key, n]) => ({ key, name: SPECIES[key].name, biome: SPECIES[key].biome, move: SPECIES[key].move, n }))
    .sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
  const emptyBiomes = Object.entries(plan.byBiome).filter(([, list]) => !list.length).map(([k]) => k);
  return { total: plan.residents.length, distinct: rows.length, rows, emptyBiomes, misses: plan.misses };
}

/** Which species the page must load a model for, nearest-first from a point. */
export function speciesLoadOrder(residents, px = 0, pz = 0) {
  const best = new Map();
  for (const r of residents) {
    const d = Math.hypot(r.x - px, r.z - pz);
    const prev = best.get(r.key);
    if (prev === undefined || d < prev) best.set(r.key, d);
  }
  return [...best.entries()].sort((a, b) => a[1] - b[1]).map(([key]) => key);
}

/** Guard: every planned resident is a species that passes the three-part gate. */
export function validatePlan(plan) {
  const bad = [];
  for (const r of plan.residents) {
    const missing = spawnable(r.species);
    if (missing.length) bad.push(`${r.id}: missing ${missing.join(', ')}`);
  }
  return bad;
}
