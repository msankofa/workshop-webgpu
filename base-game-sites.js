// Deterministic placeholder sites. Structure worldgen can replace this module without changing
// the planner: its only contract is [{x, z, tier}] or null while plan data is missing.

import { rngFrom, hash2 } from './forest-placement.js';

export const BASE_GAME_SITE_DEFAULTS = Object.freeze({ searchRings: 5, jitter: 0.3 });

function tileReady(plan, tx, tz, size) {
  const inset = Math.min(plan.post * 0.25, size * 0.01);
  const x0 = tx * size + inset, x1 = (tx + 1) * size - inset;
  const z0 = tz * size + inset, z1 = (tz + 1) * size - inset;
  return [[x0, z0], [x1, z0], [x0, z1], [x1, z1]].every(([x, z]) =>
    plan.sampleAt('planWalk', x, z) != null);
}

export function sitesForTile(seed, tx, tz, plan, options = {}) {
  if (!plan || typeof plan.sampleAt !== 'function') throw new TypeError('sitesForTile needs a plan window');
  const O = { ...BASE_GAME_SITE_DEFAULTS, ...options };
  const size = options.spacing ?? plan.tileSize;
  if (!tileReady(plan, tx, tz, size)) return null;
  if (tx === 0 && tz === 0) return [{ x: 0, z: 0, tier: 1 }];
  const randomSeed = Math.floor(hash2(tx, tz, Math.floor(seed)) * 0xffffffff) >>> 0;
  const rng = rngFrom(randomSeed);
  const candidate = {
    x: (tx + 0.5 + rng.range(-O.jitter, O.jitter)) * size,
    z: (tz + 0.5 + rng.range(-O.jitter, O.jitter)) * size,
  };
  const post = plan.post;
  const cx = Math.round(candidate.x / post), cz = Math.round(candidate.z / post);
  let best = null;
  for (let r = 0; r <= O.searchRings; r++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
    if (r && Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
    const x = (cx + dx) * post, z = (cz + dz) * post;
    if (x < tx * size || x > (tx + 1) * size || z < tz * size || z > (tz + 1) * size) continue;
    const walk = plan.sampleAt('planWalk', x, z);
    if (walk == null) return null;
    if (walk <= 0) continue;
    const dist2 = (x - candidate.x) ** 2 + (z - candidate.z) ** 2;
    if (!best || walk > best.walk || (walk === best.walk && dist2 < best.dist2)) best = { x, z, walk, dist2 };
  }
  return best ? [{ x: best.x, z: best.z, tier: 1 }] : [];
}
