// base-game-structures.js — which eco-brutalist building stands at each world-plan site, and
// how it is seated. No DOM, no renderer (THREE geometry only through the collider module). The room server and the page both call this on the
// same plan window and the same height source, so a wall is in one place on both sides.
//
// Sites come from base-game-sites.js (one per plan tile, snapped to the flattest walkable post).
// The origin tile is skipped: the spawn building lives there. Everything else is one of the
// generateEco kinds, chosen by a hash of the tile so a tile's building never depends on its
// neighbours or on the order tiles were visited.
import { hash2 } from './forest-placement.js';
import { sitesForTile } from './base-game-sites.js';
import { createSpawnBuildingModel, SPAWN_BUILDING_DEFAULTS } from './base-game-spawn-collider.js';

export const STRUCTURES_VERSION = 1;
export const STRUCTURE_DEFAULTS = Object.freeze({
  seed: 1,
  spacing: 480,          // m per site tile; the trails default, so trails meet buildings by default
  // Weighted kinds. The complex is 190 m across, so it is the rare one.
  kinds: Object.freeze([
    ['atrium', 3], ['lobby', 3], ['pergola', 3], ['slotgarden', 2], ['pavilion', 3], ['complex', 1],
  ]),
});

export const structureKey = (tx, tz) => `${tx}:${tz}`;

// The kind for a tile, from its own hash. Deterministic and order-free.
export function structureKindFor(seed, tx, tz, params = {}) {
  const kinds = params.kinds ?? STRUCTURE_DEFAULTS.kinds;
  const total = kinds.reduce((n, [, w]) => n + w, 0);
  let roll = hash2(tx, tz, (Math.floor(seed) ^ 0x51ed) | 0) * total;
  for (const [kind, w] of kinds) { roll -= w; if (roll < 0) return kind; }
  return kinds[kinds.length - 1][0];
}

// A tile's structures: null while the plan tile is not resident, [] when the tile has no site
// (or is the origin), else one { key, kind, seed, x, z, tx, tz }.
export function structuresForTile(seed, tx, tz, plan, params = {}) {
  const P = { ...STRUCTURE_DEFAULTS, ...params, seed };
  if (tx === 0 && tz === 0) return [];
  const sites = sitesForTile(P.seed, tx, tz, plan, { spacing: P.spacing });
  if (sites == null) return null;
  return sites.map((site) => ({
    key: structureKey(tx, tz), tx, tz, x: site.x, z: site.z, tier: site.tier,
    kind: structureKindFor(P.seed, tx, tz, P),
    seed: (Math.floor(hash2(tx, tz, (Math.floor(P.seed) ^ 0x7a3c) | 0) * 0x7fffffff) >>> 0) || 1,
  }));
}

// The seated model: the spawn building's own site rule (plinth under each floor slab, datum
// above the highest ground) applied to this kind at this place.
export function createStructureModel(structure, heightAt, { seaLevel = 0, ...options } = {}) {
  return createSpawnBuildingModel(heightAt, {
    ...SPAWN_BUILDING_DEFAULTS, ...options,
    kind: structure.kind, seed: structure.seed, x: structure.x, z: structure.z, seaLevel,
  });
}

// What the NPC nav bake needs: rects that stand on the floor. Anything whose base is more than
// `walkUnder` above the floor datum is a slab a bot walks under and is left out. Heights are
// relative to the datum, which is what the sight grid compares against its 1.5 m threshold.
export function structureNavRects(model, { walkUnder = 0.9 } = {}) {
  const base = model.site.baseY;
  const out = [];
  for (const list of [model.boxes.walls, model.boxes.covers, model.boxes.bars]) {
    for (const r of list) {
      if (r.y - base > walkUnder) continue;
      if (r.y + r.h - base < 0.05) continue;   // floor slabs and the plinth: the floor itself
      out.push({ x: r.x, z: r.z, w: r.w, d: r.d, h: r.y + r.h - base });
    }
  }
  return out;
}

// The XZ box a structure occupies, for residency and keep-out decisions.
export function structureBounds(model, margin = 0) {
  const fp = model.site.footprint;
  return { minX: fp.minX - margin, maxX: fp.maxX + margin, minZ: fp.minZ - margin, maxZ: fp.maxZ + margin };
}
